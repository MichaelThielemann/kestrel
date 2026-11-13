import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { orientedOriginalDimensions, plannedDimensions, plannedExt, plannedFormat } from "./plan.ts";
import type { Size } from "./sizes.ts";

describe("plannedFormat and plannedExt", () => {
  const webpSize: Size = { name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 };
  const originalSize: Size = { name: "orig", width: 2400, fit: "inside", format: "original", quality: 82 };

  it("is webp for a webp size, whatever the content type", () => {
    expect(plannedFormat(webpSize, "image/png")).toBe("webp");
    expect(plannedExt(webpSize, "image/png")).toBe("webp");
  });

  it("for format \"original\", matches jpeg, png, webp and avif content types", () => {
    expect(plannedFormat(originalSize, "image/jpeg")).toBe("jpeg");
    expect(plannedFormat(originalSize, "image/png")).toBe("png");
    expect(plannedFormat(originalSize, "image/webp")).toBe("webp");
    expect(plannedFormat(originalSize, "image/avif")).toBe("avif");
    expect(plannedExt(originalSize, "image/jpeg")).toBe("jpg");
    expect(plannedExt(originalSize, "image/png")).toBe("png");
  });

  it("reads the media type of a content type with parameters or in another case", () => {
    expect(plannedFormat(originalSize, "image/png; x=1")).toBe("png");
    expect(plannedExt(originalSize, "IMAGE/JPEG")).toBe("jpg");
  });

  it("falls back to jpeg for every other eligible type (HEIC, TIFF, BMP, ...)", () => {
    expect(plannedFormat(originalSize, "image/heic")).toBe("jpeg");
    expect(plannedFormat(originalSize, "image/tiff")).toBe("jpeg");
    expect(plannedFormat(originalSize, "image/bmp")).toBe("jpeg");
  });
});

describe("plannedDimensions", () => {
  it("inside without height: limited by the original when it is smaller than W", () => {
    expect(plannedDimensions({ name: "s", width: 1024, fit: "inside", format: "webp", quality: 82 }, 500, 300)).toEqual({ width: 500, height: 300 });
  });

  it("inside without height: limited by W when the original is larger", () => {
    expect(plannedDimensions({ name: "s", width: 1024, fit: "inside", format: "webp", quality: 82 }, 2000, 1000)).toEqual({ width: 1024, height: 512 });
  });

  it("inside with height: width-limited", () => {
    expect(plannedDimensions({ name: "s", width: 800, height: 800, fit: "inside", format: "webp", quality: 82 }, 2000, 1000)).toEqual({ width: 800, height: 400 });
  });

  it("inside with height: height-limited", () => {
    expect(plannedDimensions({ name: "s", width: 2000, height: 400, fit: "inside", format: "webp", quality: 82 }, 1000, 2000)).toEqual({ width: 200, height: 400 });
  });

  it("inside with height: a smaller original is never enlarged", () => {
    expect(plannedDimensions({ name: "s", width: 2000, height: 2000, fit: "inside", format: "webp", quality: 82 }, 500, 300)).toEqual({ width: 500, height: 300 });
  });

  it("cover: crops to the declared aspect from a larger original", () => {
    expect(plannedDimensions({ name: "s", width: 320, height: 200, fit: "cover", format: "webp", quality: 82 }, 2000, 2000)).toEqual({ width: 320, height: 200 });
  });

  it("cover: keeps the declared aspect without enlarging when the original is smaller in one dimension", () => {
    expect(plannedDimensions({ name: "s", width: 320, height: 200, fit: "cover", format: "webp", quality: 82 }, 160, 200)).toEqual({ width: 160, height: 100 });
  });

  it("cover: keeps the declared aspect without enlarging when the original is smaller in both dimensions", () => {
    expect(plannedDimensions({ name: "s", width: 320, height: 200, fit: "cover", format: "webp", quality: 82 }, 100, 100)).toEqual({ width: 100, height: 63 });
  });

  it("every value is at least 1", () => {
    expect(plannedDimensions({ name: "s", width: 2000, fit: "inside", format: "webp", quality: 82 }, 1, 1000)).toEqual({ width: 1, height: 1000 });
  });

  it("cover with a crop: plans from the crop, so a crop smaller than the size gives a smaller variant of the same ratio", () => {
    const cover: Size = { name: "s", width: 1600, height: 900, fit: "cover", format: "webp", quality: 82 };
    expect(plannedDimensions(cover, 4000, 3000, { left: 0, top: 0, width: 3200, height: 1800 })).toEqual({ width: 1600, height: 900 });
    expect(plannedDimensions(cover, 4000, 3000, { left: 100, top: 100, width: 800, height: 450 })).toEqual({ width: 800, height: 450 });
    expect(plannedDimensions(cover, 4000, 3000, null)).toEqual(plannedDimensions(cover, 4000, 3000));
  });

  it("inside ignores a crop", () => {
    const inside: Size = { name: "s", width: 1024, fit: "inside", format: "webp", quality: 82 };
    expect(plannedDimensions(inside, 2000, 1000, { left: 0, top: 0, width: 500, height: 500 })).toEqual({ width: 1024, height: 512 });
  });
});

describe("orientedOriginalDimensions", () => {
  it("reads plain width and height with no orientation tag", async () => {
    const data = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#000" } }).jpeg().toBuffer();
    expect(await orientedOriginalDimensions(data)).toEqual({ width: 300, height: 200 });
  });

  it("swaps width and height for a rotated EXIF orientation", async () => {
    const data = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#000" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(await orientedOriginalDimensions(data)).toEqual({ width: 200, height: 300 });
  });

  it("returns null for bytes sharp cannot decode", async () => {
    expect(await orientedOriginalDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
