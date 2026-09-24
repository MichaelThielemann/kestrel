import sharp from "sharp";
import { mediaTypeOf } from "./generate.ts";
import { extOf } from "./sizes.ts";
import type { Size } from "./sizes.ts";

const ORIGINAL_FORMAT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** The format a size's render will be told to produce: the size's own format for `webp`, else the type's native format (jpeg for anything else). */
export function plannedFormat(size: Size, contentType: string): string {
  return size.format === "webp" ? "webp" : (ORIGINAL_FORMAT_BY_TYPE[mediaTypeOf(contentType)] ?? "jpeg");
}

/** The extension a size's path carries, decided from `plannedFormat` alone: never depends on rendering. */
export function plannedExt(size: Size, contentType: string): string {
  return extOf(size, plannedFormat(size, contentType));
}

/** Width and height a size renders to, from the oriented original's dimensions; never enlarges, always at least 1px. */
export function plannedDimensions(size: Size, ow: number, oh: number): { width: number; height: number } {
  if (size.fit === "inside") {
    if (size.height === undefined) {
      const w = Math.min(size.width, ow);
      const h = Math.round((oh * w) / ow);
      return { width: Math.max(1, w), height: Math.max(1, h) };
    }
    const s = Math.min(size.width / ow, size.height / oh, 1);
    return { width: Math.max(1, Math.round(ow * s)), height: Math.max(1, Math.round(oh * s)) };
  }
  const targetHeight = size.height ?? size.width;
  const k = Math.min(1, ow / size.width, oh / targetHeight);
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(targetHeight * k)) };
}

/** The original's width/height after EXIF orientation, or null when sharp cannot decode it. */
export async function orientedOriginalDimensions(data: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(data, { failOn: "error" }).metadata();
    if (meta.width === undefined || meta.height === undefined) return null;
    const swapped = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
    return swapped ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}
