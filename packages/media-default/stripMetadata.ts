import { crc32 } from "node:zlib";

/** What `stripImageMetadata` made of a file: the stripped bytes, a format it does not handle, or a file of a handled format that could not be walked to its end. */
export type StripResult = { kind: "stripped"; data: Uint8Array } | { kind: "unsupported" } | { kind: "malformed" };

const MALFORMED: StripResult = { kind: "malformed" };
const UNSUPPORTED: StripResult = { kind: "unsupported" };
const ascii = (d: Uint8Array, at: number, length: number): string => String.fromCharCode(...d.subarray(at, at + length));
const u16be = (d: Uint8Array, at: number): number => ((d[at] ?? 0) << 8) | (d[at + 1] ?? 0);
const u32be = (d: Uint8Array, at: number): number => (d[at] ?? 0) * 2 ** 24 + ((d[at + 1] ?? 0) << 16) + ((d[at + 2] ?? 0) << 8) + (d[at + 3] ?? 0);
const u32le = (d: Uint8Array, at: number): number => (d[at] ?? 0) + ((d[at + 1] ?? 0) << 8) + ((d[at + 2] ?? 0) << 16) + (d[at + 3] ?? 0) * 2 ** 24;
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function tiffOrientation(d: Uint8Array): number | null {
  const header = ascii(d, 0, 2);
  if ((header !== "II" && header !== "MM") || d.length < 8) return null;
  const little = header === "II";
  const r16 = (at: number): number => (little ? (d[at] ?? 0) | ((d[at + 1] ?? 0) << 8) : u16be(d, at));
  const r32 = (at: number): number => (little ? u32le(d, at) : u32be(d, at));
  const ifd = r32(4);
  if (ifd + 2 > d.length) return null;
  const count = r16(ifd);
  for (let entry = 0; entry < count; entry += 1) {
    const at = ifd + 2 + entry * 12;
    if (at + 12 > d.length) return null;
    if (r16(at) !== 0x0112) continue;
    const value = r16(at + 8);
    return r16(at + 2) === 3 && value >= 2 && value <= 8 ? value : null;
  }
  return null;
}

function orientationTiff(orientation: number): Uint8Array {
  return Uint8Array.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
}

const EXIF_PREFIX = "Exif\0\0";
const tiffOf = (payload: Uint8Array): Uint8Array => (ascii(payload, 0, 6) === EXIF_PREFIX ? payload.subarray(6) : payload);

function nextJpegMarker(d: Uint8Array, from: number): number {
  for (let i = from; i + 1 < d.length; i += 1) {
    if (d[i] === 0xff && d[i + 1] !== 0) return i;
  }
  return d.length;
}

/** The EXIF orientation (2 to 8) of a JPEG, PNG or WebP file; stray bytes between JPEG segments are skipped like a decoder does; `null` for orientation 1, no EXIF, or a file that does not parse. */
export function exifOrientation(d: Uint8Array): number | null {
  if (d[0] === 0xff && d[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= d.length) {
      if (d[at] !== 0xff || d[at + 1] === 0) {
        at = nextJpegMarker(d, at + 1);
        continue;
      }
      const marker = d[at + 1] ?? 0;
      if (marker === 0xda || marker === 0xd9) return null;
      const length = u16be(d, at + 2);
      if (marker === 0xe1 && ascii(d, at + 4, 6) === EXIF_PREFIX) return tiffOrientation(d.subarray(at + 10, at + 2 + length));
      at += 2 + length;
    }
    return null;
  }
  if (d.length >= 8 && d[0] === 0x89 && ascii(d, 1, 3) === "PNG") {
    let at = 8;
    while (at + 12 <= d.length) {
      const length = u32be(d, at);
      const type = ascii(d, at + 4, 4);
      if (type === "eXIf") return tiffOrientation(d.subarray(at + 8, at + 8 + length));
      if (type === "IDAT") return null;
      at += 12 + length;
    }
    return null;
  }
  if (d.length >= 12 && ascii(d, 0, 4) === "RIFF" && ascii(d, 8, 4) === "WEBP") {
    let at = 12;
    while (at + 8 <= d.length) {
      const length = u32le(d, at + 4);
      if (ascii(d, at, 4) === "EXIF") return tiffOrientation(tiffOf(d.subarray(at + 8, at + 8 + length)));
      at += 8 + length + (length % 2);
    }
  }
  return null;
}

const JPEG_THUMBLESS_JFIF_LENGTH = 16;

function jpegSegmentKept(marker: number, segment: Uint8Array): Uint8Array | null {
  const payload = segment.subarray(4);
  if (marker === 0xe0) {
    if (ascii(payload, 0, 5) !== "JFIF\0" || payload.length < 14) return null;
    const header = Uint8Array.from(segment.subarray(0, 4 + 14));
    header[2] = 0;
    header[3] = JPEG_THUMBLESS_JFIF_LENGTH;
    header[4 + 12] = 0;
    header[4 + 13] = 0;
    return header;
  }
  if (marker === 0xe2) return ascii(payload, 0, 12) === "ICC_PROFILE\0" ? segment : null;
  if (marker === 0xee) return ascii(payload, 0, 5) === "Adobe" ? segment : null;
  return marker >= 0xe1 && marker <= 0xef ? null : marker === 0xfe ? null : segment;
}

function stripJpeg(d: Uint8Array): StripResult {
  const orientation = exifOrientation(d);
  const orientationSegment = orientation === null
    ? null
    : (() => {
        const tiff = orientationTiff(orientation);
        const body = Uint8Array.from([...Buffer.from(EXIF_PREFIX, "latin1"), ...tiff]);
        return Uint8Array.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
      })();
  const parts: Uint8Array[] = [d.subarray(0, 2)];
  let pending = orientationSegment;
  const flushOrientation = (): void => {
    if (pending !== null) parts.push(pending);
    pending = null;
  };
  let at = 2;
  while (at < d.length) {
    if (d[at] !== 0xff || d[at + 1] === 0) {
      at = nextJpegMarker(d, at + 1);
      continue;
    }
    while (d[at + 1] === 0xff) at += 1;
    const marker = d[at + 1];
    if (marker === undefined) return MALFORMED;
    if (marker === 0xd9) {
      flushOrientation();
      parts.push(d.subarray(at, at + 2));
      return { kind: "stripped", data: concat(parts) };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(d.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > d.length) return MALFORMED;
    const length = u16be(d, at + 2);
    if (length < 2 || at + 2 + length > d.length) return MALFORMED;
    const kept = jpegSegmentKept(marker, d.subarray(at, at + 2 + length));
    if (marker !== 0xe0) flushOrientation();
    if (kept !== null) parts.push(kept);
    at += 2 + length;
    if (marker !== 0xda) continue;
    let end = at;
    while (end < d.length) {
      if (d[end] !== 0xff) {
        end += 1;
        continue;
      }
      const next = d[end + 1];
      if (next === undefined) {
        end = d.length;
      } else if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        end += 2;
      } else if (next === 0xff) {
        end += 1;
      } else {
        break;
      }
    }
    parts.push(d.subarray(at, end));
    at = end;
  }
  return { kind: "stripped", data: concat(parts) };
}

const PNG_KEPT = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "hIST", "pHYs", "cICP", "mDCV", "cLLI", "acTL", "fcTL", "fdAT"]);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([Buffer.from(type, "latin1"), data]);
  return concat([Uint8Array.from(be32(data.length)), body, Uint8Array.from(be32(crc32(body)))]);
}

function stripPng(d: Uint8Array): StripResult {
  if (ascii(d, 12, 4) !== "IHDR") return MALFORMED;
  const orientation = exifOrientation(d);
  const parts: Uint8Array[] = [d.subarray(0, 8)];
  let exifPending = orientation === null ? null : pngChunk("eXIf", orientationTiff(orientation));
  let at = 8;
  while (at + 12 <= d.length) {
    const length = u32be(d, at);
    if (at + 12 + length > d.length) return MALFORMED;
    const type = ascii(d, at + 4, 4);
    if (type === "IDAT" && exifPending !== null) {
      parts.push(exifPending);
      exifPending = null;
    }
    if (PNG_KEPT.has(type)) parts.push(d.subarray(at, at + 12 + length));
    at += 12 + length;
    if (type === "IEND") return { kind: "stripped", data: concat(parts) };
  }
  return MALFORMED;
}

const WEBP_KEPT = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ICCP", "ANIM", "ANMF"]);
const WEBP_FLAG_XMP = 0x04;
const WEBP_FLAG_EXIF = 0x08;

function stripWebp(d: Uint8Array): StripResult {
  const riffEnd = u32le(d, 4) + 8;
  if (riffEnd > d.length || riffEnd < 12) return MALFORMED;
  const orientation = exifOrientation(d.subarray(0, riffEnd));
  const chunks: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const length = u32le(d, at + 4);
    const end = at + 8 + length + (length % 2);
    if (end > riffEnd) return MALFORMED;
    if (WEBP_KEPT.has(ascii(d, at, 4))) chunks.push(Uint8Array.from(d.subarray(at, end)));
    at = end;
  }
  const extended = chunks[0] !== undefined && ascii(chunks[0], 0, 4) === "VP8X";
  if (extended && chunks[0] !== undefined) {
    const flags = chunks[0][8] ?? 0;
    chunks[0][8] = orientation === null ? flags & ~(WEBP_FLAG_EXIF | WEBP_FLAG_XMP) : (flags & ~WEBP_FLAG_XMP) | WEBP_FLAG_EXIF;
    if (orientation !== null) {
      const tiff = orientationTiff(orientation);
      chunks.push(Uint8Array.from([...Buffer.from("EXIF", "latin1"), ...le32(tiff.length), ...tiff]));
    }
  }
  const size = 4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return { kind: "stripped", data: concat([Buffer.from("RIFF", "latin1"), Uint8Array.from(le32(size)), Buffer.from("WEBP", "latin1"), ...chunks]) };
}

function gifSubBlocksEnd(d: Uint8Array, at: number): number {
  let i = at;
  while (i < d.length) {
    const size = d[i] ?? 0;
    i += 1 + size;
    if (size === 0) return i <= d.length ? i : -1;
  }
  return -1;
}

function stripGif(d: Uint8Array): StripResult {
  if (d.length < 13) return MALFORMED;
  const packed = d[10] ?? 0;
  let at = 13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  if (at > d.length) return MALFORMED;
  const parts: Uint8Array[] = [d.subarray(0, at)];
  while (at < d.length) {
    const block = d[at];
    if (block === 0x3b) {
      parts.push(d.subarray(at, at + 1));
      return { kind: "stripped", data: concat(parts) };
    }
    if (block === 0x2c) {
      const local = ((d[at + 9] ?? 0) & 0x80) !== 0 ? 3 * 2 ** (((d[at + 9] ?? 0) & 7) + 1) : 0;
      const end = gifSubBlocksEnd(d, at + 11 + local);
      if (end === -1) return MALFORMED;
      parts.push(d.subarray(at, end));
      at = end;
      continue;
    }
    if (block !== 0x21) return MALFORMED;
    const label = d[at + 1] ?? 0;
    const end = gifSubBlocksEnd(d, at + 2);
    if (end === -1) return MALFORMED;
    const isXmp = label === 0xff && ascii(d, at + 3, 11) === "XMP DataXMP";
    if (label !== 0xfe && !isXmp) parts.push(d.subarray(at, end));
    at = end;
  }
  return MALFORMED;
}

/**
 * Removes the metadata a JPEG, PNG, WebP or GIF carries besides its pixels: EXIF (GPS position, camera,
 * timestamps), XMP, IPTC, comments, text chunks, embedded thumbnails, multi-picture data and any data after
 * the end of the image. Pixel data, colour profiles and animation are copied byte for byte, so nothing is
 * re-encoded. The EXIF orientation (2 to 8) is kept as the only tag in a minimal EXIF block, because the
 * pixels are not rotated. Other formats come back as `unsupported`, a file of a handled format that cannot be
 * walked to its end as `malformed`. Stray bytes between JPEG segments are dropped, as decoders skip them.
 */
export function stripImageMetadata(data: Uint8Array): StripResult {
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) return stripJpeg(data);
  if (data.length >= 8 && data[0] === 0x89 && ascii(data, 1, 3) === "PNG") return stripPng(data);
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") return stripWebp(data);
  if (data.length >= 6 && (ascii(data, 0, 6) === "GIF87a" || ascii(data, 0, 6) === "GIF89a")) return stripGif(data);
  return UNSUPPORTED;
}
