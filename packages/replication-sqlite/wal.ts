export const WAL_HEADER_SIZE = 32;
export const FRAME_HEADER_SIZE = 24;

export interface WalHeader {
  magic: number;
  pageSize: number;
  salt1: number;
  salt2: number;
}

export interface FrameInfo {
  pageNumber: number;
  commitSize: number;
  salt1: number;
  salt2: number;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

export function parseWalHeader(d: Uint8Array): WalHeader | null {
  if (d.byteLength < WAL_HEADER_SIZE) return null;
  const v = view(d);
  const magic = v.getUint32(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return null;
  const pageSize = v.getUint32(8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return null;
  return { magic, pageSize, salt1: v.getUint32(16), salt2: v.getUint32(20) };
}

export function parseFrameHeader(d: Uint8Array, offset: number): FrameInfo {
  const v = view(d);
  return { pageNumber: v.getUint32(offset), commitSize: v.getUint32(offset + 4), salt1: v.getUint32(offset + 8), salt2: v.getUint32(offset + 12) };
}

export function frameSize(pageSize: number): number {
  return FRAME_HEADER_SIZE + pageSize;
}

const grown = new WeakSet<ArrayBufferLike>();
const GROWTH = 1.25;

/**
 * Applies the committed frames of `segment`, a WAL header followed by frames, to the database image `image` and
 * returns the image after them: each commit frame sets the image to its database size, zero-filled where it grows,
 * and writes the pages of its transaction. Frames after the last commit frame, or from the first frame whose salts
 * differ from the header's, are left out. The image is written in place while it has room; when a segment needs
 * more, it moves once into a larger buffer, which later calls with the returned image grow into before they copy
 * it again, so a restore applying many segments to a growing database copies the image only a few times. The
 * returned image can be a view on a larger buffer: its `byteLength` is the database size, and its `buffer` can
 * hold bytes after that. To keep `image` as it is, pass a copy of it.
 */
export function applySegment(image: Uint8Array, segment: Uint8Array): Uint8Array {
  const header = parseWalHeader(segment);
  if (!header) throw new Error("replication/sqlite: segment has no WAL header");
  const size = frameSize(header.pageSize);
  let largest = 0;
  for (let offset = WAL_HEADER_SIZE; offset + size <= segment.byteLength; offset += size) {
    const frame = parseFrameHeader(segment, offset);
    if (frame.salt1 !== header.salt1 || frame.salt2 !== header.salt2) break;
    largest = Math.max(largest, frame.commitSize * header.pageSize);
  }
  const ours = image.byteOffset === 0 && grown.has(image.buffer);
  let buffer = ours ? new Uint8Array(image.buffer) : image;
  let length = image.byteLength;
  if (largest > buffer.byteLength) {
    const next = new Uint8Array(ours ? Math.max(largest, Math.ceil(buffer.byteLength * GROWTH)) : largest);
    next.set(buffer.subarray(0, length));
    grown.add(next.buffer);
    buffer = next;
  }
  let first = WAL_HEADER_SIZE;
  for (let offset = WAL_HEADER_SIZE; offset + size <= segment.byteLength; offset += size) {
    const frame = parseFrameHeader(segment, offset);
    if (frame.salt1 !== header.salt1 || frame.salt2 !== header.salt2) break;
    if (frame.commitSize === 0) continue;
    const needed = frame.commitSize * header.pageSize;
    if (needed > length) buffer.fill(0, length, needed);
    length = needed;
    for (let at = first; at <= offset; at += size) {
      const page = parseFrameHeader(segment, at).pageNumber;
      const to = (page - 1) * header.pageSize;
      if (page >= 1 && to + header.pageSize <= length) buffer.set(segment.subarray(at + FRAME_HEADER_SIZE, at + size), to);
    }
    first = offset + size;
  }
  return length === buffer.byteLength ? buffer : buffer.subarray(0, length);
}

/** Running WAL checksum pair, as stored in the WAL header and in every frame header. */
export type WalChecksum = readonly [number, number];

/** Continues a WAL checksum over `data` (a multiple of 8 bytes), in the byte order the WAL magic selects. */
export function walChecksum(magic: number, data: Uint8Array, start: WalChecksum): WalChecksum {
  const v = view(data);
  const littleEndian = (magic & 1) === 0;
  let s1 = start[0];
  let s2 = start[1];
  for (let i = 0; i + 8 <= data.byteLength; i += 8) {
    s1 = (s1 + v.getUint32(i, littleEndian) + s2) >>> 0;
    s2 = (s2 + v.getUint32(i + 4, littleEndian) + s1) >>> 0;
  }
  return [s1, s2];
}

/** The checksum stored in the WAL header when it matches the header's content, else `null` (a torn or foreign header). */
export function walHeaderChecksum(d: Uint8Array): WalChecksum | null {
  const header = parseWalHeader(d);
  if (!header) return null;
  const v = view(d);
  const stored: WalChecksum = [v.getUint32(24), v.getUint32(28)];
  const computed = walChecksum(header.magic, d.subarray(0, 24), [0, 0]);
  return computed[0] === stored[0] && computed[1] === stored[1] ? stored : null;
}

/**
 * Accepts whole WAL frames in file order and keeps those that belong to a committed transaction.
 * A frame whose salts or checksum do not continue the chain ends the scan, like SQLite's own WAL recovery.
 */
export class FrameScanner {
  private readonly header: WalHeader;
  private readonly size: number;
  private running: WalChecksum;
  private pending: Uint8Array[] = [];
  private committed: Uint8Array[] = [];
  /** Number of committed frames held for the next segment. */
  committedFrames: number;
  /** Byte length of the committed frames held for the next segment. */
  committedBytes: number;
  /** Checksum after the last committed frame seen. */
  checksum: WalChecksum;
  /** True once a frame fails the salt or checksum check; later frames are ignored. */
  stopped: boolean;

  constructor(header: WalHeader, start: WalChecksum) {
    this.header = header;
    this.size = frameSize(header.pageSize);
    this.running = start;
    this.checksum = start;
    this.committedFrames = 0;
    this.committedBytes = 0;
    this.stopped = false;
  }

  /** Scans `frames`, a run of whole frames; the bytes are copied. */
  push(frames: Uint8Array): void {
    for (let offset = 0; !this.stopped && offset + this.size <= frames.byteLength; offset += this.size) {
      const frame = frames.subarray(offset, offset + this.size);
      const info = parseFrameHeader(frame, 0);
      const v = view(frame);
      const sum = walChecksum(this.header.magic, frame.subarray(FRAME_HEADER_SIZE), walChecksum(this.header.magic, frame.subarray(0, 8), this.running));
      if (info.salt1 !== this.header.salt1 || info.salt2 !== this.header.salt2 || sum[0] !== v.getUint32(16) || sum[1] !== v.getUint32(20)) {
        this.stopped = true;
        break;
      }
      this.running = sum;
      this.pending.push(frame.slice());
      if (info.commitSize > 0) {
        for (const p of this.pending) this.committed.push(p);
        this.committedFrames += this.pending.length;
        this.committedBytes += this.pending.length * this.size;
        this.pending = [];
        this.checksum = sum;
      }
    }
  }

  /** Returns the committed frames collected so far as one segment behind `headerBytes`, and forgets them. */
  takeSegment(headerBytes: Uint8Array): { segment: Uint8Array; frames: number } {
    const segment = new Uint8Array(WAL_HEADER_SIZE + this.committedBytes);
    segment.set(headerBytes.subarray(0, WAL_HEADER_SIZE));
    let at = WAL_HEADER_SIZE;
    for (const frame of this.committed) {
      segment.set(frame, at);
      at += frame.byteLength;
    }
    const frames = this.committedFrames;
    this.committed = [];
    this.committedFrames = 0;
    this.committedBytes = 0;
    return { segment, frames };
  }
}
