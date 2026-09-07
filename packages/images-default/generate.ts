import sharp from "sharp";
import { extOf } from "./sizes.ts";
import type { Size } from "./sizes.ts";

export interface Original {
  id: string;
  key: string;
  contentType: string;
}

export function eligible(contentType: string): boolean {
  return contentType.startsWith("image/") && contentType !== "image/svg+xml" && contentType !== "image/gif";
}

export interface Rendered {
  data: Uint8Array;
  width: number;
  height: number;
  format: string;
  ext: string;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = { webp: "image/webp", jpeg: "image/jpeg", png: "image/png" };

export async function render(data: Uint8Array, size: Size): Promise<Rendered> {
  const image = sharp(data, { failOn: "error" });
  const meta = await image.metadata();
  const pipeline = image.rotate().resize({ width: size.width, height: size.height, fit: size.fit, withoutEnlargement: true });
  const output = size.format === "webp" ? pipeline.webp({ quality: size.quality }) : pipeline.toFormat(meta.format ?? "jpeg");

  const { data: buffer, info } = await output.toBuffer({ resolveWithObject: true });
  const format = info.format;
  return {
    data: buffer,
    width: info.width,
    height: info.height,
    format,
    ext: extOf(size, format),
    contentType: CONTENT_TYPES[format] ?? `image/${format}`,
  };
}
