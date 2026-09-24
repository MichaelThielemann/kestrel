import sharp, { type FormatEnum } from "sharp";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { extOf } from "./sizes.ts";
import type { Size } from "./sizes.ts";

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

const CONTENT_TYPES: Record<string, string> = { webp: "image/webp", jpeg: "image/jpeg", png: "image/png", avif: "image/avif" };

export function contentTypeOf(format: string): string {
  return CONTENT_TYPES[format] ?? `image/${format}`;
}

export interface Planned {
  width: number;
  height: number;
  format: string;
}

export type Renderer = (data: Uint8Array, size: Size, planned: Planned) => Promise<Rendered>;

/** Renders to exactly `planned.width`x`planned.height` in `planned.format`: the plan, not the decoder, decides the output shape. */
export async function render(data: Uint8Array, size: Size, planned: Planned): Promise<Rendered> {
  const pipeline = sharp(data, { failOn: "error" })
    .rotate()
    .resize({ width: planned.width, height: planned.height, fit: size.fit === "cover" ? "cover" : "fill" });
  const output = size.format === "webp" ? pipeline.webp({ quality: size.quality }) : pipeline.toFormat(boundaryCast<keyof FormatEnum>(planned.format, "host"));
  const { data: buffer, info } = await output.toBuffer({ resolveWithObject: true });
  const format = info.format;
  return { data: buffer, width: info.width, height: info.height, format, ext: extOf(size, format), contentType: contentTypeOf(format) };
}
