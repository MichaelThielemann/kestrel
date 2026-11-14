/** A rectangle normalised to 0..1 on the original after EXIF orientation: `x`/`y` is the top-left corner, `w`/`h` the extent. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How an image is framed: one focus rectangle and optional manual crops keyed by reduced aspect ratio (`"16:9"`). */
export interface Framing {
  /** The area every `cover` variant keeps in view; a rectangle with `w` and `h` of 0 is a point. `null` keeps the centre. */
  focus: Rect | null;
  /** Manual crops by ratio key; a crop for a ratio beats the focus for every `cover` size of that ratio. */
  crops: Record<string, Rect>;
}

/** A crop in whole pixels of the oriented original. */
export interface PixelCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The fields of an image size the framing reads. */
export interface FramingSize {
  width: number;
  height?: number | undefined;
  fit: "inside" | "cover";
}

/** The outcome of `parseFraming`, shaped like a kestrel `Result`. */
export type FramingParse = { ok: true; value: Framing } | { ok: false; error: string };

/** The framing of an image nobody has framed: no focus, no crops, so every variant is cut from the centre. */
export const EMPTY_FRAMING: Framing = Object.freeze({ focus: null, crops: Object.freeze({}) });

/** How far, relatively, a manual crop's pixel ratio may stray from its key when `parseFraming` is given the oriented dimensions. */
export const CROP_RATIO_TOLERANCE = 0.02;

/** The most manual crops one framing holds. */
export const MAX_CROPS = 64;

const EDGE_EPSILON = 1e-9;
const RATIO_KEY = /^([1-9][0-9]{0,4}):([1-9][0-9]{0,4})$/;
const CROP_STRING = /^(\d+),(\d+),(\d+),(\d+)$/;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function ratioOf(key: string): { w: number; h: number } | null {
  const match = RATIO_KEY.exec(key);
  if (match === null) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return gcd(w, h) === 1 ? { w, h } : null;
}

/** The ratio key of a `cover` size, its width and height reduced by their greatest common divisor (`1600x900` gives `"16:9"`); `null` for an `inside` size. Sizes with nearly the same ratio get separate keys. */
export function ratioKey(size: FramingSize): string | null {
  if (size.fit !== "cover" || size.height === undefined || size.width < 1 || size.height < 1) return null;
  const d = gcd(size.width, size.height);
  return `${size.width / d}:${size.height / d}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function validDimensions(ow: number, oh: number): boolean {
  return Number.isInteger(ow) && Number.isInteger(oh) && ow >= 1 && oh >= 1;
}

function place(width: number, height: number, cx: number, cy: number, ow: number, oh: number): PixelCrop {
  const w = clamp(Math.round(width), 1, ow);
  const h = clamp(Math.round(height), 1, oh);
  return { left: clamp(Math.round(cx - w / 2), 0, ow - w), top: clamp(Math.round(cy - h / 2), 0, oh - h), width: w, height: h };
}

function largest(r: number, ow: number, oh: number): { width: number; height: number } {
  return ow / oh >= r ? { width: oh * r, height: oh } : { width: ow, height: ow / r };
}

/** The largest rectangle of the ratio centred in the image: the crop a variant gets without a framing. `null` for an invalid key or dimensions. */
export function centredCrop(key: string, ow: number, oh: number): PixelCrop | null {
  const ratio = ratioOf(key);
  if (ratio === null || !validDimensions(ow, oh)) return null;
  const { width, height } = largest(ratio.w / ratio.h, ow, oh);
  return place(width, height, ow / 2, oh / 2, ow, oh);
}

function resolvedCrop(framing: Framing, key: string, ow: number, oh: number): PixelCrop | null {
  const ratio = ratioOf(key);
  if (ratio === null || !validDimensions(ow, oh)) return null;
  const r = ratio.w / ratio.h;
  const manual = Object.hasOwn(framing.crops, key) ? framing.crops[key] : undefined;
  if (manual !== undefined) {
    const area = Math.max(manual.w * ow * manual.h * oh, 0);
    let width = Math.sqrt(area * r);
    let height = width / r;
    const fit = Math.min(1, ow / Math.max(width, EDGE_EPSILON), oh / Math.max(height, EDGE_EPSILON));
    width *= fit;
    height *= fit;
    return place(width, height, (manual.x + manual.w / 2) * ow, (manual.y + manual.h / 2) * oh, ow, oh);
  }
  const { width, height } = largest(r, ow, oh);
  if (framing.focus === null) return place(width, height, ow / 2, oh / 2, ow, oh);
  const focus = framing.focus;
  return place(width, height, (focus.x + focus.w / 2) * ow, (focus.y + focus.h / 2) * oh, ow, oh);
}

function withinAPixel(a: PixelCrop, b: PixelCrop): boolean {
  return (
    Math.abs(a.left - b.left) <= 1 &&
    Math.abs(a.top - b.top) <= 1 &&
    Math.abs(a.left + a.width - (b.left + b.width)) <= 1 &&
    Math.abs(a.top + a.height - (b.top + b.height)) <= 1
  );
}

/**
 * The crop of a ratio key in pixels of the oriented original (`ow` x `oh`): the manual crop of that ratio, brought to the exact ratio
 * around its centre; else the largest rectangle of the ratio centred on the focus and shifted back inside the image; else `null`.
 * A crop whose left, top, right and bottom edges each lie within one pixel of `centredCrop` is `null` as well: it renders as the
 * centred cut, so a variant without a framing and one framed to the centre up to rounding render alike.
 */
export function cropForRatio(framing: Framing, key: string, ow: number, oh: number): PixelCrop | null {
  const crop = resolvedCrop(framing, key, ow, oh);
  const centred = centredCrop(key, ow, oh);
  if (crop === null || centred === null || withinAPixel(crop, centred)) return null;
  return crop;
}

/** The crop a size renders with, by `cropForRatio` on its ratio key, so `null` for a cut within a pixel of the centred one; always `null` for an `inside` size. */
export function effectiveCrop(framing: Framing, size: FramingSize, ow: number, oh: number): PixelCrop | null {
  const key = ratioKey(size);
  return key === null ? null : cropForRatio(framing, key, ow, oh);
}

/** Whether the focus lies within the crop the ratio key renders with (manual, focus-centred or centred); `true` without a focus. */
export function focusFits(framing: Framing, key: string, ow: number, oh: number): boolean {
  const focus = framing.focus;
  if (focus === null) return true;
  const crop = resolvedCrop(framing, key, ow, oh);
  if (crop === null) return false;
  const slack = 1;
  return (
    focus.x * ow >= crop.left - slack &&
    focus.y * oh >= crop.top - slack &&
    (focus.x + focus.w) * ow <= crop.left + crop.width + slack &&
    (focus.y + focus.h) * oh <= crop.top + crop.height + slack
  );
}

/** A crop as the string `"left,top,width,height"`; `""` for `null`, the centre. */
export function formatCrop(crop: PixelCrop | null): string {
  return crop === null ? "" : `${crop.left},${crop.top},${crop.width},${crop.height}`;
}

/** The crop of a `formatCrop` string; `null` for `""`, a missing value or anything malformed. */
export function parseCrop(value: string | null | undefined): PixelCrop | null {
  const match = CROP_STRING.exec(value ?? "");
  if (match === null) return null;
  const [left, top, width, height] = [match[1], match[2], match[3], match[4]].map(Number);
  if (left === undefined || top === undefined || width === undefined || height === undefined || width < 1 || height < 1) return null;
  return { left, top, width, height };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRect(value: unknown, path: string, allowEmpty: boolean): Rect | string {
  if (!isRecord(value)) return `${path} must be an object with x, y, w and h`;
  const extra = Object.keys(value).find((key) => !["x", "y", "w", "h"].includes(key));
  if (extra !== undefined) return `${path}.${extra} is not a rectangle field`;
  const fields: Record<string, number> = {};
  for (const name of ["x", "y", "w", "h"]) {
    const field = value[name];
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0 || field > 1) return `${path}.${name} must be a number from 0 to 1`;
    fields[name] = field;
  }
  const rect = { x: fields.x ?? 0, y: fields.y ?? 0, w: fields.w ?? 0, h: fields.h ?? 0 };
  if (!allowEmpty && (rect.w === 0 || rect.h === 0)) return `${path} must have a width and a height above 0`;
  if (rect.x + rect.w > 1 + EDGE_EPSILON || rect.y + rect.h > 1 + EDGE_EPSILON) return `${path} must lie within the image`;
  return rect;
}

/**
 * Validates a framing: `focus` a rectangle or point within 0..1, or `null`; `crops` an object of rectangles with a width and height
 * under reduced ratio keys (`"16:9"`, not `"32:18"`), at most `MAX_CROPS`. A missing field is empty, unknown fields are rejected.
 * Given the oriented dimensions, a crop's pixel ratio must also match its key within `CROP_RATIO_TOLERANCE`.
 */
export function parseFraming(value: unknown, oriented?: { width: number; height: number }): FramingParse {
  if (!isRecord(value)) return { ok: false, error: "framing must be an object" };
  const extra = Object.keys(value).find((key) => key !== "focus" && key !== "crops");
  if (extra !== undefined) return { ok: false, error: `${extra} is not a framing field` };
  let focus: Rect | null = null;
  if (value.focus !== undefined && value.focus !== null) {
    const rect = parseRect(value.focus, "focus", true);
    if (typeof rect === "string") return { ok: false, error: rect };
    focus = rect;
  }
  const crops: Record<string, Rect> = {};
  if (value.crops !== undefined) {
    if (!isRecord(value.crops)) return { ok: false, error: "crops must be an object keyed by ratio" };
    const entries = Object.entries(value.crops);
    if (entries.length > MAX_CROPS) return { ok: false, error: `crops holds at most ${MAX_CROPS} ratios` };
    for (const [key, raw] of entries) {
      const ratio = ratioOf(key);
      if (ratio === null) return { ok: false, error: `crops key "${key}" must be a reduced ratio such as "16:9"` };
      const rect = parseRect(raw, `crops["${key}"]`, false);
      if (typeof rect === "string") return { ok: false, error: rect };
      if (oriented !== undefined) {
        const actual = (rect.w * oriented.width) / (rect.h * oriented.height);
        if (Math.abs(actual / (ratio.w / ratio.h) - 1) > CROP_RATIO_TOLERANCE) return { ok: false, error: `crops["${key}"] does not have the ratio ${key}` };
      }
      crops[key] = rect;
    }
  }
  return { ok: true, value: { focus, crops } };
}
