export interface Size {
  width: number;
  height: number;
}

function u16be(d: Uint8Array, i: number): number {
  return ((d[i] ?? 0) << 8) | (d[i + 1] ?? 0);
}
function u16le(d: Uint8Array, i: number): number {
  return (d[i] ?? 0) | ((d[i + 1] ?? 0) << 8);
}
function u32be(d: Uint8Array, i: number): number {
  return ((d[i] ?? 0) * 2 ** 24) + ((d[i + 1] ?? 0) << 16) + ((d[i + 2] ?? 0) << 8) + (d[i + 3] ?? 0);
}
function u24le(d: Uint8Array, i: number): number {
  return (d[i] ?? 0) | ((d[i + 1] ?? 0) << 8) | ((d[i + 2] ?? 0) << 16);
}
function ascii(d: Uint8Array, i: number, n: number): string {
  return String.fromCharCode(...d.subarray(i, i + n));
}

export function imageSize(d: Uint8Array): Size | null {
  if (d.length >= 24 && ascii(d, 1, 3) === "PNG") return { width: u32be(d, 16), height: u32be(d, 20) };
  if (d.length >= 10 && ascii(d, 0, 3) === "GIF") return { width: u16le(d, 6), height: u16le(d, 8) };
  if (d.length >= 30 && ascii(d, 0, 4) === "RIFF" && ascii(d, 8, 4) === "WEBP") {
    const chunk = ascii(d, 12, 4);
    if (chunk === "VP8X") return { width: u24le(d, 24) + 1, height: u24le(d, 27) + 1 };
    if (chunk === "VP8L") {
      const b0 = d[21] ?? 0, b1 = d[22] ?? 0, b2 = d[23] ?? 0, b3 = d[24] ?? 0;
      return { width: (b0 | ((b1 & 0x3f) << 8)) + 1, height: ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) + 1 };
    }
    if (chunk === "VP8 ") return { width: u16le(d, 26) & 0x3fff, height: u16le(d, 28) & 0x3fff };
    return null;
  }
  if (d.length >= 4 && d[0] === 0xff && d[1] === 0xd8) {
    let i = 2;
    while (i + 9 < d.length) {
      if (d[i] !== 0xff) return null;
      const marker = d[i + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const length = u16be(d, i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(d, i + 5), width: u16be(d, i + 7) };
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + length;
    }
  }
  return null;
}
