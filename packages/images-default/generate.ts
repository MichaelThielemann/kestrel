import sharp, { type FormatEnum } from "sharp";
import type { MediaFilter } from "@michaelthielemann/kestrel-contracts/media";
import { mediaTypeAllowed } from "@michaelthielemann/kestrel-contracts/mediaType";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { extOf } from "./sizes.ts";
import type { Size } from "./sizes.ts";

/** The media types that get variants: every image type except GIF and the XML image types, SVG among them, whose bytes a browser could open as a document. */
export const ELIGIBLE = { types: ["image/*"], excludeTypes: ["image/gif", "image/*+xml"] } as const satisfies MediaFilter;

/** Whether a media type gets variants, by the same rule `ELIGIBLE` gives a `media@1` provider; parameters and case are ignored, and a value that is not exactly one media type never does. */
export function eligible(contentType: string): boolean {
  return mediaTypeAllowed(ELIGIBLE.types, ELIGIBLE.excludeTypes, contentType);
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
