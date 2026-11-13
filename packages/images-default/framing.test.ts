import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FRAMING,
  centredCrop,
  cropForRatio,
  effectiveCrop,
  focusFits,
  formatCrop,
  parseCrop,
  parseFraming,
  ratioKey,
  type Framing,
  type PixelCrop,
} from "./framing.ts";
import type { Size } from "./sizes.ts";

const hero: Size = { name: "hero", width: 1600, height: 900, fit: "cover", format: "webp", quality: 82 };
const square: Size = { name: "square", width: 400, height: 400, fit: "cover", format: "webp", quality: 82 };
const portrait: Size = { name: "portrait", width: 300, height: 600, fit: "cover", format: "webp", quality: 82 };
const medium: Size = { name: "medium", width: 1024, fit: "inside", format: "webp", quality: 82 };

function framing(partial: Partial<Framing>): Framing {
  return { ...EMPTY_FRAMING, ...partial };
}

function inside(crop: PixelCrop, ow: number, oh: number): boolean {
  return [crop.left, crop.top, crop.width, crop.height].every(Number.isInteger) && crop.left >= 0 && crop.top >= 0 && crop.width >= 1 && crop.height >= 1 && crop.left + crop.width <= ow && crop.top + crop.height <= oh;
}

describe("ratioKey", () => {
  it("reduces a cover size's width and height by their greatest common divisor", () => {
    expect(ratioKey(hero)).toBe("16:9");
    expect(ratioKey(square)).toBe("1:1");
    expect(ratioKey(portrait)).toBe("1:2");
    expect(ratioKey({ width: 1000, height: 562, fit: "cover" })).toBe("500:281");
  });

  it("is null for an inside size and for a cover size without a height", () => {
    expect(ratioKey(medium)).toBeNull();
    expect(ratioKey({ width: 800, height: 600, fit: "inside" })).toBeNull();
    expect(ratioKey({ width: 800, fit: "cover" })).toBeNull();
  });
});

describe("effectiveCrop", () => {
  it("is null without a framing, so the variant stays cut from the centre", () => {
    expect(effectiveCrop(EMPTY_FRAMING, hero, 4000, 3000)).toBeNull();
    expect(effectiveCrop(EMPTY_FRAMING, square, 4000, 3000)).toBeNull();
  });

  it("is null for an inside size, whatever the framing", () => {
    const set = framing({ focus: { x: 0, y: 0, w: 0.1, h: 0.1 }, crops: { "1:1": { x: 0, y: 0, w: 0.5, h: 0.5 } } });
    expect(effectiveCrop(set, medium, 2000, 2000)).toBeNull();
  });

  it("centres the largest rectangle of the size's ratio on the focus", () => {
    const set = framing({ focus: { x: 0.2, y: 0.4, w: 0.1, h: 0.2 } });
    expect(effectiveCrop(set, square, 4000, 2000)).toEqual({ left: 0, top: 0, width: 2000, height: 2000 });
    expect(effectiveCrop(framing({ focus: { x: 0.6, y: 0.4, w: 0.1, h: 0.2 } }), square, 4000, 2000)).toEqual({ left: 1600, top: 0, width: 2000, height: 2000 });
  });

  it("shifts the rectangle back inside the image for a focus at the edge or in a corner", () => {
    const right = framing({ focus: { x: 0.95, y: 0.45, w: 0.05, h: 0.1 } });
    expect(effectiveCrop(right, square, 4000, 2000)).toEqual({ left: 2000, top: 0, width: 2000, height: 2000 });
    const corner = framing({ focus: { x: 0, y: 0.9, w: 0.05, h: 0.1 } });
    expect(effectiveCrop(corner, hero, 2000, 2000)).toEqual({ left: 0, top: 875, width: 2000, height: 1125 });
  });

  it("treats a point focus as its centre", () => {
    const point = framing({ focus: { x: 0.75, y: 0.5, w: 0, h: 0 } });
    expect(effectiveCrop(point, square, 4000, 2000)).toEqual({ left: 2000, top: 0, width: 2000, height: 2000 });
  });

  it("keeps the centre of a focus wider than the ratio allows inside the crop", () => {
    const wide = framing({ focus: { x: 0.15, y: 0.4, w: 0.8, h: 0.2 } });
    const crop = effectiveCrop(wide, portrait, 4000, 2000);
    expect(crop).toEqual({ left: 1700, top: 0, width: 1000, height: 2000 });
    expect(focusFits(wide, "1:2", 4000, 2000)).toBe(false);
  });

  it("is null when the focus lands the crop exactly in the centre", () => {
    const centre = framing({ focus: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } });
    expect(effectiveCrop(centre, square, 4000, 2000)).toBeNull();
    expect(effectiveCrop(framing({ focus: { x: 0, y: 0, w: 0.1, h: 0.1 } }), square, 2000, 2000)).toBeNull();
  });

  it("uses the manual crop of the size's ratio before the focus", () => {
    const set = framing({ focus: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, crops: { "1:1": { x: 0.1, y: 0.2, w: 0.25, h: 0.5 } } });
    expect(effectiveCrop(set, square, 4000, 2000)).toEqual({ left: 400, top: 400, width: 1000, height: 1000 });
    expect(effectiveCrop(set, hero, 4000, 2000)).toEqual({ left: 444, top: 0, width: 3556, height: 2000 });
  });

  it("brings a manual crop to the exact ratio around its centre and keeps it inside the image", () => {
    const set = framing({ crops: { "16:9": { x: 0.5, y: 0.5, w: 0.5, h: 0.3 } } });
    const crop = effectiveCrop(set, hero, 1000, 1000);
    expect(crop).not.toBeNull();
    if (crop === null) return;
    expect(inside(crop, 1000, 1000)).toBe(true);
    expect(Math.abs(crop.width / crop.height - 16 / 9)).toBeLessThan(0.01);
    expect(crop.left + crop.width).toBe(1000);
  });

  it("swaps the roles of width and height for an EXIF-rotated original through the oriented dimensions", () => {
    const set = framing({ focus: { x: 0, y: 0, w: 0.2, h: 0.2 } });
    expect(effectiveCrop(set, hero, 3000, 4000)).toEqual({ left: 0, top: 0, width: 3000, height: 1688 });
    expect(effectiveCrop(set, hero, 4000, 3000)).toEqual({ left: 0, top: 0, width: 4000, height: 2250 });
  });

  it("gives whole pixels that never leave the image", () => {
    const dims: Array<[number, number]> = [[1, 1], [3, 7], [17, 5], [333, 211], [4000, 3000], [3001, 4003]];
    const sizes = [hero, square, portrait, { width: 1000, height: 562, fit: "cover" as const }];
    const frames: Framing[] = [
      framing({ focus: { x: 0, y: 0, w: 0, h: 0 } }),
      framing({ focus: { x: 1, y: 1, w: 0, h: 0 } }),
      framing({ focus: { x: 0.333, y: 0.777, w: 0.1, h: 0.05 } }),
      framing({ crops: { "16:9": { x: 0.999, y: 0, w: 0.001, h: 0.001 }, "1:1": { x: 0, y: 0, w: 1, h: 1 }, "1:2": { x: 0.3, y: 0.3, w: 0.7, h: 0.7 } } }),
    ];
    for (const [ow, oh] of dims) {
      for (const size of sizes) {
        for (const frame of frames) {
          const crop = effectiveCrop(frame, size, ow, oh);
          if (crop !== null) expect(inside(crop, ow, oh), `${ow}x${oh} ${size.width}x${size.height ?? ""} ${JSON.stringify(frame)}`).toBe(true);
        }
      }
    }
  });
});

describe("cropForRatio and centredCrop", () => {
  it("cropForRatio answers per ratio key what effectiveCrop answers per size", () => {
    const set = framing({ focus: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, crops: { "1:2": { x: 0.5, y: 0, w: 0.25, h: 1 } } });
    expect(cropForRatio(set, "16:9", 4000, 3000)).toEqual(effectiveCrop(set, hero, 4000, 3000));
    expect(cropForRatio(set, "1:2", 4000, 3000)).toEqual(effectiveCrop(set, portrait, 4000, 3000));
    expect(cropForRatio(set, "not-a-key", 4000, 3000)).toBeNull();
  });

  it("centredCrop is the largest centred rectangle of the ratio", () => {
    expect(centredCrop("1:1", 4000, 2000)).toEqual({ left: 1000, top: 0, width: 2000, height: 2000 });
    expect(centredCrop("16:9", 1600, 900)).toEqual({ left: 0, top: 0, width: 1600, height: 900 });
    expect(centredCrop("x", 10, 10)).toBeNull();
  });
});

describe("focusFits", () => {
  it("is true without a focus and when the focus lies within the crop", () => {
    expect(focusFits(EMPTY_FRAMING, "1:1", 4000, 2000)).toBe(true);
    expect(focusFits(framing({ focus: { x: 0.9, y: 0.1, w: 0.1, h: 0.8 } }), "1:1", 4000, 2000)).toBe(true);
  });

  it("is false when the focus is larger than the ratio allows", () => {
    expect(focusFits(framing({ focus: { x: 0, y: 0, w: 1, h: 0.5 } }), "1:1", 4000, 2000)).toBe(false);
  });

  it("is false when the manual crop of the ratio leaves part of the focus out", () => {
    const set = framing({ focus: { x: 0.8, y: 0.2, w: 0.1, h: 0.1 }, crops: { "1:1": { x: 0, y: 0, w: 0.5, h: 1 } } });
    expect(focusFits(set, "1:1", 4000, 2000)).toBe(false);
    expect(focusFits(set, "16:9", 4000, 2000)).toBe(true);
  });
});

describe("formatCrop and parseCrop", () => {
  it("round-trips a crop and stores the centre as the empty string", () => {
    const crop = { left: 12, top: 0, width: 640, height: 360 };
    expect(formatCrop(crop)).toBe("12,0,640,360");
    expect(parseCrop("12,0,640,360")).toEqual(crop);
    expect(formatCrop(null)).toBe("");
    expect(parseCrop("")).toBeNull();
    expect(parseCrop(null)).toBeNull();
    expect(parseCrop(undefined)).toBeNull();
    expect(parseCrop("1,2,0,4")).toBeNull();
    expect(parseCrop("1,2,3")).toBeNull();
  });
});

describe("parseFraming", () => {
  it("fills a missing focus and missing crops with the empty framing", () => {
    expect(parseFraming({})).toEqual({ ok: true, value: { focus: null, crops: {} } });
    expect(parseFraming({ focus: null })).toEqual({ ok: true, value: { focus: null, crops: {} } });
  });

  it("accepts a focus rectangle, a point focus and crops under reduced ratio keys", () => {
    const value = { focus: { x: 0.25, y: 0.5, w: 0, h: 0 }, crops: { "16:9": { x: 0, y: 0, w: 1, h: 0.5625 } } };
    expect(parseFraming(value)).toEqual({ ok: true, value });
  });

  it("rejects values that are not a framing", () => {
    const bad: unknown[] = [
      null,
      [],
      "focus",
      { focus: { x: 0, y: 0, w: 0.5 } },
      { focus: { x: -0.1, y: 0, w: 0.5, h: 0.5 } },
      { focus: { x: 0.6, y: 0, w: 0.5, h: 0.5 } },
      { focus: { x: 0, y: 0, w: Number.NaN, h: 0.5 } },
      { focus: { x: 0, y: 0, w: "0.5", h: 0.5 } },
      { focus: { x: 0, y: 0, w: 0.5, h: 0.5, z: 1 } },
      { crops: [] },
      { crops: { "16:9": { x: 0, y: 0, w: 0, h: 0.5 } } },
      { crops: { "32:18": { x: 0, y: 0, w: 1, h: 0.5 } } },
      { crops: { "16x9": { x: 0, y: 0, w: 1, h: 0.5 } } },
      { crops: { "0:1": { x: 0, y: 0, w: 1, h: 0.5 } } },
      { other: true },
    ];
    for (const value of bad) {
      const parsed = parseFraming(value);
      expect(parsed.ok, JSON.stringify(value)).toBe(false);
      if (!parsed.ok) expect(parsed.error).not.toBe("");
    }
  });

  it("with the oriented dimensions, rejects a crop whose pixel ratio is off its key", () => {
    const value = { crops: { "1:1": { x: 0, y: 0, w: 0.5, h: 1 } } };
    expect(parseFraming(value, { width: 4000, height: 2000 }).ok).toBe(true);
    expect(parseFraming(value, { width: 2000, height: 4000 }).ok).toBe(false);
    expect(parseFraming(value).ok).toBe(true);
  });
});

describe("the framing subpath", () => {
  it("imports nothing, so code that also runs in a browser can use it", () => {
    const source = readFileSync(new URL("./framing.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(|\bprocess\.|\bBuffer\b/);
  });

  it("is published as its own subpath", () => {
    const pkg: unknown = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(pkg).toMatchObject({ exports: { "./framing": "./framing.ts" }, publishConfig: { exports: { "./framing": { types: "./dist/framing.d.ts", default: "./dist/framing.js" } } } });
  });
});
