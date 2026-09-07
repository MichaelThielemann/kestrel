import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { eligible, render } from "./generate.ts";
import type { Size } from "./sizes.ts";

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).jpeg().toBuffer();
}

describe("eligible", () => {
  it("accepts raster image content types", () => {
    expect(eligible("image/jpeg")).toBe(true);
    expect(eligible("image/png")).toBe(true);
    expect(eligible("image/webp")).toBe(true);
  });

  it("rejects svg and gif", () => {
    expect(eligible("image/svg+xml")).toBe(false);
    expect(eligible("image/gif")).toBe(false);
  });

  it("rejects non-image content types", () => {
    expect(eligible("application/pdf")).toBe(false);
    expect(eligible("text/plain")).toBe(false);
  });
});

describe("render", () => {
  const medium: Size = { name: "medium", width: 1024, fit: "inside", format: "webp", quality: 82 };
  const thumbCover: Size = { name: "thumb", width: 320, height: 200, fit: "cover", format: "webp", quality: 82 };
  const xl: Size = { name: "xl", width: 2400, fit: "inside", format: "webp", quality: 82 };
  const original: Size = { name: "orig", width: 2400, fit: "inside", format: "original", quality: 82 };

  it("resizes 1200x800 to 1024 wide, preserving aspect ratio, as webp", async () => {
    const data = await jpeg(1200, 800);
    const result = await render(data, medium);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(683);
    expect(result.format).toBe("webp");
    expect(result.ext).toBe("webp");
    expect(result.contentType).toBe("image/webp");
  });

  it("crops to exact dimensions for cover fit", async () => {
    const data = await jpeg(1200, 800);
    const result = await render(data, thumbCover);
    expect(result.width).toBe(320);
    expect(result.height).toBe(200);
  });

  it("does not enlarge a smaller original", async () => {
    const data = await jpeg(200, 100);
    const result = await render(data, xl);
    expect(result.width).toBe(200);
    expect(result.height).toBe(100);
  });

  it("keeps original format when format is original", async () => {
    const data = await jpeg(1200, 800);
    const result = await render(data, original);
    expect(result.format).toBe("jpeg");
    expect(result.ext).toBe("jpg");
    expect(result.contentType).toBe("image/jpeg");
  });

  it("rejects corrupt bytes", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(render(data, medium)).rejects.toThrow();
  });

  it("rejects a truncated jpeg", async () => {
    const data = await jpeg(1200, 800);
    const truncated = data.slice(0, Math.floor(data.byteLength * 0.6));
    await expect(render(truncated, medium)).rejects.toThrow();
  });

  it("does not enlarge a smaller original for cover fit, keeping its original dimensions", async () => {
    const data = await jpeg(200, 100);
    const result = await render(data, thumbCover);
    expect(result.width).toBe(200);
    expect(result.height).toBe(100);
  });
});
