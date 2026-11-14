import { describe, expect, it } from "vitest";
import { exifOrientation, stripImageMetadata } from "./stripMetadata.ts";

const enc = new TextEncoder();
const bytes = (...parts: Array<number[] | Uint8Array | string>): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...enc.encode(p)] : [...p])));
const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const text = (d: Uint8Array): string => Buffer.from(d).toString("latin1");
const includes = (d: Uint8Array, needle: string): boolean => text(d).includes(needle);

function tiff(orientation: number | null, little = false): number[] {
  const w16 = little ? (n: number) => u16(n).reverse() : u16;
  const w32 = little ? u32le : u32;
  const entries: number[][] = [];
  if (orientation !== null) entries.push([...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0]);
  entries.push([...w16(0x8825), ...w16(4), ...w32(1), ...w32(8 + 2 + entries.length * 12 + 12 + 4 + 40)]);
  const ifd = [...w16(entries.length), ...entries.flat(), ...w32(0)];
  return [...(little ? bytes("II*\0") : bytes("MM\0*")), ...w32(8), ...ifd, ...bytes("GPSLatitude-52.5200N-GPSLongitude-13.4050E")];
}

function jpegSegment(marker: number, payload: Uint8Array | number[]): number[] {
  return [0xff, marker, ...u16(payload.length + 2), ...payload];
}

function jpeg(options: { orientation?: number | null; little?: boolean } = {}): Uint8Array {
  const jfif = jpegSegment(0xe0, bytes("JFIF\0", [1, 1, 0], u16(72), u16(72), [2, 2], "THUMBNAIL-PIXELS".slice(0, 12)));
  const exif = jpegSegment(0xe1, bytes("Exif\0\0", tiff(options.orientation ?? null, options.little)));
  const xmp = jpegSegment(0xe1, bytes("http://ns.adobe.com/xap/1.0/\0", "<x:xmpmeta>PrivateAuthor</x:xmpmeta>"));
  const iptc = jpegSegment(0xed, bytes("Photoshop 3.0\0", "IPTC-Caption"));
  const comment = jpegSegment(0xfe, bytes("CommentSecret"));
  const icc = jpegSegment(0xe2, bytes("ICC_PROFILE\0", [1, 1], "ICCDATA"));
  const mpf = jpegSegment(0xe2, bytes("MPF\0", "MultiPictureData"));
  const adobe = jpegSegment(0xee, bytes("Adobe", [0, 100], [0, 0], [0, 0], [1]));
  const dqt = jpegSegment(0xdb, new Uint8Array(65).fill(8));
  const sof = jpegSegment(0xc0, bytes([8], u16(48), u16(64), [1, 1, 0x11, 0]));
  const dht = jpegSegment(0xc4, new Uint8Array(20).fill(1));
  const sos = jpegSegment(0xda, bytes([1, 1, 0], [0, 63, 0]));
  const scan = bytes([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0x00, 0x78]);
  const secondSos = jpegSegment(0xda, bytes([1, 1, 0], [1, 63, 0]));
  return bytes([0xff, 0xd8], jfif, exif, xmp, iptc, comment, icc, mpf, adobe, dqt, sof, dht, sos, scan, secondSos, [0x9a, 0xbc], [0xff, 0xd9], "TRAILING-EMBEDDED-THUMBNAIL-GPS");
}

describe("stripImageMetadata: JPEG", () => {
  it("removes EXIF with GPS, XMP, IPTC, comments, multi-picture data and trailing data", () => {
    const result = stripImageMetadata(jpeg({ orientation: null }));
    expect(result.kind).toBe("stripped");
    if (result.kind !== "stripped") return;
    for (const needle of ["GPSLatitude", "Exif", "PrivateAuthor", "IPTC-Caption", "CommentSecret", "MultiPictureData", "TRAILING", "THUMBNAIL"]) expect(includes(result.data, needle)).toBe(false);
  });

  it("keeps everything a decoder needs, byte for byte: tables, frame, scans, colour profile, Adobe transform", () => {
    const source = jpeg({ orientation: null });
    const result = stripImageMetadata(source);
    if (result.kind !== "stripped") throw new Error("expected stripped");
    const out = text(result.data);
    for (const needle of ["ICC_PROFILE", "ICCDATA", "Adobe", "\xff\xda"]) expect(out).toContain(needle);
    expect(out.startsWith("\xff\xd8\xff\xe0")).toBe(true);
    expect(out.endsWith("\x9a\xbc\xff\xd9")).toBe(true);
    const scan = bytes([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0x00, 0x78]);
    expect(out).toContain(text(scan));
    expect(result.data.length).toBeLessThan(source.length);
  });

  it("keeps the JFIF header but drops its embedded thumbnail", () => {
    const result = stripImageMetadata(jpeg());
    if (result.kind !== "stripped") throw new Error("expected stripped");
    expect(Array.from(result.data.subarray(2, 20))).toEqual([0xff, 0xe0, 0x00, 0x10, ...bytes("JFIF\0"), 1, 1, 0, ...u16(72), ...u16(72), 0, 0]);
  });

  it.each([[6, false], [3, true], [8, false]])("keeps orientation %i as the only EXIF tag", (orientation, little) => {
    const result = stripImageMetadata(jpeg({ orientation, little }));
    if (result.kind !== "stripped") throw new Error("expected stripped");
    expect(exifOrientation(result.data)).toBe(orientation);
    expect(includes(result.data, "GPS")).toBe(false);
    const exifAt = text(result.data).indexOf("Exif\0\0");
    expect(result.data[exifAt - 4]).toBe(0xff);
    expect(result.data[exifAt - 3]).toBe(0xe1);
    expect(exifAt).toBeGreaterThan(text(result.data).indexOf("JFIF"));
  });

  it("writes no EXIF segment for the default orientation", () => {
    const result = stripImageMetadata(jpeg({ orientation: 1 }));
    if (result.kind !== "stripped") throw new Error("expected stripped");
    expect(includes(result.data, "Exif")).toBe(false);
    expect(exifOrientation(result.data)).toBeNull();
  });

  it("is idempotent", () => {
    const once = stripImageMetadata(jpeg({ orientation: 6 }));
    if (once.kind !== "stripped") throw new Error("expected stripped");
    const twice = stripImageMetadata(once.data);
    if (twice.kind !== "stripped") throw new Error("expected stripped");
    expect(Array.from(twice.data)).toEqual(Array.from(once.data));
  });

  it("copies a scan that ends without an end-of-image marker", () => {
    const cut = jpeg().subarray(0, -34);
    const result = stripImageMetadata(cut);
    expect(result.kind).toBe("stripped");
    if (result.kind === "stripped") expect(includes(result.data, "GPS")).toBe(false);
  });

  it("skips stray bytes between segments the way decoders do and still removes the metadata", () => {
    const source = jpeg({ orientation: 6 });
    const dqt = source.findIndex((b, i) => b === 0xff && source[i + 1] === 0xdb);
    const withStray = bytes(source.subarray(0, dqt), [0x00, 0x13], source.subarray(dqt));
    const result = stripImageMetadata(withStray);
    expect(result.kind).toBe("stripped");
    if (result.kind !== "stripped") return;
    for (const needle of ["GPSLatitude", "PrivateAuthor", "CommentSecret", "TRAILING"]) expect(includes(result.data, needle)).toBe(false);
    expect(exifOrientation(result.data)).toBe(6);
    const clean = stripImageMetadata(source);
    if (clean.kind !== "stripped") throw new Error("expected stripped");
    expect(Array.from(result.data)).toEqual(Array.from(clean.data));
  });

  it("finds the orientation behind stray bytes between segments", () => {
    const source = jpeg({ orientation: 8 });
    const exif = source.findIndex((b, i) => b === 0xff && source[i + 1] === 0xe1);
    expect(exifOrientation(bytes(source.subarray(0, exif), [0x00], source.subarray(exif)))).toBe(8);
  });

  it("reports a segment that runs past the end of the file as malformed", () => {
    const broken = bytes([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff], "Exif\0\0GPS");
    expect(stripImageMetadata(broken).kind).toBe("malformed");
  });
});

function pngChunk(type: string, data: Uint8Array | number[]): number[] {
  const body = bytes(type, data);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}
function crc32(d: Uint8Array): number {
  let c = ~0;
  for (const byte of d) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function png(orientation: number | null = null): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk("IHDR", bytes(u32(16), u32(8), [8, 2, 0, 0, 0])),
    pngChunk("sRGB", [0]),
    pngChunk("pHYs", bytes(u32(2835), u32(2835), [1])),
    pngChunk("tEXt", bytes("Author\0PrivateAuthor")),
    pngChunk("zTXt", bytes("Comment\0", [0], "PrivateCompressed")),
    pngChunk("iTXt", bytes("XML:com.adobe.xmp\0", [0, 0], "\0\0", "<x:xmpmeta>PrivateXmp</x:xmpmeta>")),
    pngChunk("tIME", [7, 0xe9, 1, 2, 3, 4, 5]),
    pngChunk("eXIf", tiff(orientation)),
    pngChunk("prVt", bytes("PrivateUnknown")),
    pngChunk("IDAT", [1, 2, 3, 4]),
    pngChunk("IDAT", [5, 6]),
    pngChunk("IEND", []),
    "TRAILING-AFTER-IEND",
  );
}

describe("stripImageMetadata: PNG", () => {
  it("removes text, XMP, timestamp, EXIF with GPS, unknown chunks and data after IEND", () => {
    const result = stripImageMetadata(png());
    if (result.kind !== "stripped") throw new Error("expected stripped");
    for (const needle of ["PrivateAuthor", "PrivateCompressed", "PrivateXmp", "tIME", "eXIf", "GPS", "prVt", "PrivateUnknown", "TRAILING"]) expect(includes(result.data, needle)).toBe(false);
  });

  it("keeps the chunks that decide how the pixels look, in order, with valid checksums", () => {
    const result = stripImageMetadata(png());
    if (result.kind !== "stripped") throw new Error("expected stripped");
    const types: string[] = [];
    let at = 8;
    while (at < result.data.length) {
      const length = ((result.data[at] ?? 0) * 2 ** 24) + ((result.data[at + 1] ?? 0) << 16) + ((result.data[at + 2] ?? 0) << 8) + (result.data[at + 3] ?? 0);
      const body = result.data.subarray(at + 4, at + 8 + length);
      const stored = ((result.data[at + 8 + length] ?? 0) * 2 ** 24) + ((result.data[at + 9 + length] ?? 0) << 16) + ((result.data[at + 10 + length] ?? 0) << 8) + (result.data[at + 11 + length] ?? 0);
      expect(stored).toBe(crc32(body));
      types.push(text(body.subarray(0, 4)));
      at += 12 + length;
    }
    expect(types).toEqual(["IHDR", "sRGB", "pHYs", "IDAT", "IDAT", "IEND"]);
  });

  it("keeps the orientation in a minimal eXIf chunk before the image data", () => {
    const result = stripImageMetadata(png(6));
    if (result.kind !== "stripped") throw new Error("expected stripped");
    expect(exifOrientation(result.data)).toBe(6);
    expect(includes(result.data, "GPS")).toBe(false);
    expect(text(result.data).indexOf("eXIf")).toBeLessThan(text(result.data).indexOf("IDAT"));
  });

  it("is idempotent", () => {
    const once = stripImageMetadata(png(8));
    if (once.kind !== "stripped") throw new Error("expected stripped");
    const twice = stripImageMetadata(once.data);
    if (twice.kind !== "stripped") throw new Error("expected stripped");
    expect(Array.from(twice.data)).toEqual(Array.from(once.data));
  });

  it("reports a chunk that runs past the end of the file as malformed", () => {
    const broken = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk("IHDR", bytes(u32(1), u32(1), [8, 2, 0, 0, 0])), u32(9999), "tEXt");
    expect(stripImageMetadata(broken).kind).toBe("malformed");
  });
});

function riffChunk(type: string, data: Uint8Array | number[]): number[] {
  return [...bytes(type), ...u32le(data.length), ...data, ...(data.length % 2 === 1 ? [0] : [])];
}
function webp(options: { orientation?: number | null; flags?: number; extended?: boolean } = {}): Uint8Array {
  const extended = options.extended ?? true;
  const chunks = [
    ...(extended ? riffChunk("VP8X", bytes([options.flags ?? 0x3c], [0, 0, 0], [15, 0, 0], [7, 0, 0])) : []),
    ...(extended ? riffChunk("ICCP", bytes("ICCDATA")) : []),
    ...riffChunk("VP8L", bytes("PIXELS")),
    ...(extended ? riffChunk("EXIF", bytes(tiff(options.orientation ?? null))) : []),
    ...(extended ? riffChunk("XMP ", bytes("<x:xmpmeta>PrivateXmp</x:xmpmeta>")) : []),
    ...(extended ? riffChunk("junk", bytes("PrivateJunk")) : []),
  ];
  return bytes("RIFF", u32le(4 + chunks.length), "WEBP", chunks);
}

describe("stripImageMetadata: WebP", () => {
  it("removes EXIF, XMP and unknown chunks, clears their flags and fixes the RIFF size", () => {
    const result = stripImageMetadata(webp());
    if (result.kind !== "stripped") throw new Error("expected stripped");
    for (const needle of ["GPS", "EXIF", "PrivateXmp", "XMP ", "PrivateJunk"]) expect(includes(result.data, needle)).toBe(false);
    for (const needle of ["VP8X", "ICCP", "ICCDATA", "VP8L", "PIXELS"]) expect(includes(result.data, needle)).toBe(true);
    const riffSize = result.data[4]! | (result.data[5]! << 8) | (result.data[6]! << 16) | (result.data[7]! << 24);
    expect(riffSize).toBe(result.data.length - 8);
    expect(result.data[20]! & 0x0c).toBe(0);
    expect(result.data[20]! & 0x30).toBe(0x30);
  });

  it("keeps the orientation in a minimal EXIF chunk and its flag", () => {
    const result = stripImageMetadata(webp({ orientation: 6 }));
    if (result.kind !== "stripped") throw new Error("expected stripped");
    expect(exifOrientation(result.data)).toBe(6);
    expect(includes(result.data, "GPS")).toBe(false);
    expect(result.data[20]! & 0x08).toBe(0x08);
    const riffSize = result.data[4]! | (result.data[5]! << 8) | (result.data[6]! << 16) | (result.data[7]! << 24);
    expect(riffSize).toBe(result.data.length - 8);
  });

  it("leaves a simple file without extended header as it is", () => {
    const source = webp({ extended: false });
    const result = stripImageMetadata(source);
    if (result.kind !== "stripped") throw new Error("expected stripped");
    expect(Array.from(result.data)).toEqual(Array.from(source));
  });

  it("is idempotent", () => {
    const once = stripImageMetadata(webp({ orientation: 3 }));
    if (once.kind !== "stripped") throw new Error("expected stripped");
    const twice = stripImageMetadata(once.data);
    if (twice.kind !== "stripped") throw new Error("expected stripped");
    expect(Array.from(twice.data)).toEqual(Array.from(once.data));
  });

  it("reports a chunk that runs past the end of the file as malformed", () => {
    const broken = bytes("RIFF", u32le(100), "WEBP", "VP8X", u32le(5000), [0, 0]);
    expect(stripImageMetadata(broken).kind).toBe("malformed");
  });
});

function gif(): Uint8Array {
  const subBlocks = (payload: string): number[] => [payload.length, ...bytes(payload), 0];
  return bytes(
    "GIF89a", u16(1).reverse(), u16(1).reverse(), [0x80, 0, 0], [0, 0, 0, 255, 255, 255],
    [0x21, 0xff, 11], "NETSCAPE2.0", [3, 1, 0, 0, 0],
    [0x21, 0xff, 11], "XMP DataXMP", subBlocks("PrivateXmp"),
    [0x21, 0xfe], subBlocks("PrivateComment"),
    [0x21, 0xf9, 4, 0, 10, 0, 0, 0],
    [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2], subBlocks("\x44\x01"),
    [0x3b], "TRAILING-AFTER-TRAILER",
  );
}

describe("stripImageMetadata: GIF", () => {
  it("removes comment extensions, XMP and trailing data, and keeps the animation loop and frames", () => {
    const result = stripImageMetadata(gif());
    if (result.kind !== "stripped") throw new Error("expected stripped");
    for (const needle of ["PrivateXmp", "XMP DataXMP", "PrivateComment", "TRAILING"]) expect(includes(result.data, needle)).toBe(false);
    for (const needle of ["NETSCAPE2.0", "\x21\xf9", "\x2c"]) expect(includes(result.data, needle)).toBe(true);
    expect(result.data[result.data.length - 1]).toBe(0x3b);
  });

  it("reports a file without a trailer as malformed", () => {
    expect(stripImageMetadata(gif().subarray(0, 30)).kind).toBe("malformed");
  });
});

describe("stripImageMetadata: other input", () => {
  it("leaves formats it does not handle alone", () => {
    expect(stripImageMetadata(bytes("%PDF-1.7 not an image")).kind).toBe("unsupported");
    expect(stripImageMetadata(bytes([1, 2, 3])).kind).toBe("unsupported");
    expect(stripImageMetadata(bytes([0, 0, 0, 0x1c], "ftypavif")).kind).toBe("unsupported");
  });
});

describe("exifOrientation", () => {
  it("reads the orientation of both byte orders and answers null without one", () => {
    expect(exifOrientation(jpeg({ orientation: 5, little: true }))).toBe(5);
    expect(exifOrientation(jpeg({ orientation: 7 }))).toBe(7);
    expect(exifOrientation(jpeg())).toBeNull();
    expect(exifOrientation(bytes([1, 2, 3]))).toBeNull();
  });
});
