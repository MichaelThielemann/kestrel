import { cropForRatio, focusFits, ratioKey, type Framing, type PixelCrop } from "./framing.ts";
import type { Size } from "./sizes.ts";

/** One ratio of the effective `cover` sizes, as a media item is framed for it. */
export interface FramingRatio {
  /** The reduced ratio key, e.g. `"16:9"`. */
  key: string;
  /** The names of the effective `cover` sizes with this ratio, in declaration order. */
  sizes: string[];
  /** Whether the framing holds a manual crop for this ratio. */
  manual: boolean;
  /** Whether the focus lies within the crop this ratio renders with; `true` without a focus or without known dimensions. */
  fits: boolean;
  /** The pixel crop this ratio renders with on the oriented original; `null` cuts from the centre. */
  crop: PixelCrop | null;
}

/** A media item's framing together with one entry per ratio of the effective `cover` sizes. */
export interface FramingView extends Framing {
  /** The width of the original after its EXIF orientation, the width every rectangle and pixel crop refers to; `null` when it is not known. */
  width: number | null;
  /** The height of the original after its EXIF orientation; `null` when it is not known. */
  height: number | null;
  ratios: FramingRatio[];
}

function knownDimensions(ow: number, oh: number): boolean {
  return Number.isInteger(ow) && Number.isInteger(oh) && ow >= 1 && oh >= 1;
}

/** The view of `framing` for `sizes` on an oriented original of `ow` x `oh`; dimensions below 1px give no crops and count every focus as fitting. */
export function framingView(framing: Framing, sizes: readonly Size[], ow: number, oh: number): FramingView {
  const byKey = new Map<string, string[]>();
  for (const size of sizes) {
    const key = ratioKey(size);
    if (key === null) continue;
    const names = byKey.get(key) ?? [];
    names.push(size.name);
    byKey.set(key, names);
  }
  const known = knownDimensions(ow, oh);
  const ratios = [...byKey].map(([key, names]) => ({
    key,
    sizes: names,
    manual: Object.hasOwn(framing.crops, key),
    fits: known ? focusFits(framing, key, ow, oh) : true,
    crop: known ? cropForRatio(framing, key, ow, oh) : null,
  }));
  return { focus: framing.focus, crops: framing.crops, width: known ? ow : null, height: known ? oh : null, ratios };
}
