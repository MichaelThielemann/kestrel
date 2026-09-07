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

export function applySegment(image: Uint8Array, segment: Uint8Array): Uint8Array {
  const header = parseWalHeader(segment);
  if (!header) throw new Error("replication/sqlite: segment has no WAL header");
  const size = frameSize(header.pageSize);
  let out = image;
  let pending: Array<{ pageNumber: number; data: Uint8Array }> = [];
  for (let offset = WAL_HEADER_SIZE; offset + size <= segment.byteLength; offset += size) {
    const frame = parseFrameHeader(segment, offset);
    if (frame.salt1 !== header.salt1 || frame.salt2 !== header.salt2) break;
    pending.push({ pageNumber: frame.pageNumber, data: segment.subarray(offset + FRAME_HEADER_SIZE, offset + size) });
    if (frame.commitSize > 0) {
      const needed = frame.commitSize * header.pageSize;
      if (out.byteLength !== needed) {
        const grown = new Uint8Array(needed);
        grown.set(out.subarray(0, Math.min(out.byteLength, needed)));
        out = grown;
      }
      for (const p of pending) out.set(p.data, (p.pageNumber - 1) * header.pageSize);
      pending = [];
    }
  }
  return out;
}
