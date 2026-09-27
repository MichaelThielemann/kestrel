import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { mediaTypeAllowed } from "@michaelthielemann/kestrel-contracts/helpers/mediaType";
import { createFakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { ELIGIBLE, eligible, render } from "./generate.ts";
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

  it("rejects an XML image type, which a browser would open as a document that can run script", () => {
    expect(eligible("image/foo+xml")).toBe(false);
    expect(eligible("IMAGE/X-DRAWING+XML; charset=utf-8")).toBe(false);
  });

  it("judges the media type alone, ignoring parameters and case", () => {
    expect(eligible("image/svg+xml; charset=utf-8")).toBe(false);
    expect(eligible("IMAGE/GIF")).toBe(false);
    expect(eligible("Image/JPEG")).toBe(true);
    expect(eligible("image/png; x=1")).toBe(true);
  });
});

describe("one eligibility rule for this module and a media@1 provider", () => {
  const table: Array<[string, boolean]> = [
    ["image/jpeg", true],
    ["IMAGE/PNG", true],
    ["image/heic", true],
    ["image/gif", false],
    ["image/svg+xml", false],
    ["image/foo+xml", false],
    ["application/pdf", false],
    ["image/png, text/html", false],
  ];

  it("eligible answers exactly what the pattern filter ELIGIBLE gives a provider", () => {
    for (const [contentType, expected] of table) {
      expect(eligible(contentType), contentType).toBe(expected);
      expect(mediaTypeAllowed(ELIGIBLE.types, ELIGIBLE.excludeTypes, contentType), contentType).toBe(expected);
    }
  });

  it("a provider's count of ELIGIBLE equals the number of stored items eligible accepts", async () => {
    const media = createFakeMedia();
    let accepted = 0;
    for (const [contentType] of table) {
      if (contentType.includes(",")) continue;
      media.add({ contentType, data: new Uint8Array([1]) });
      if (eligible(contentType)) accepted += 1;
    }
    expect(accepted).toBe(3);
    expect(expectOk(await media.count(ELIGIBLE))).toBe(accepted);
  });
});

describe("render", () => {
  const medium: Size = { name: "medium", width: 1024, fit: "inside", format: "webp", quality: 82 };
  const thumbCover: Size = { name: "thumb", width: 320, height: 200, fit: "cover", format: "webp", quality: 82 };
  const original: Size = { name: "orig", width: 2400, fit: "inside", format: "original", quality: 82 };

  it("renders to exactly the planned width and height, as webp", async () => {
    const data = await jpeg(1200, 800);
    const result = await render(data, medium, { width: 1024, height: 683, format: "webp" });
    expect(result.width).toBe(1024);
    expect(result.height).toBe(683);
    expect(result.format).toBe("webp");
    expect(result.ext).toBe("webp");
    expect(result.contentType).toBe("image/webp");
  });

  it("crops to exactly the planned dimensions for cover fit", async () => {
    const data = await jpeg(1200, 800);
    const result = await render(data, thumbCover, { width: 320, height: 200, format: "webp" });
    expect(result.width).toBe(320);
    expect(result.height).toBe(200);
  });

  it("renders in the planned format for format \"original\", regardless of the decoder's own report", async () => {
    const data = await jpeg(1200, 800);
    const result = await render(data, original, { width: 2400, height: 1600, format: "png" });
    expect(result.format).toBe("png");
    expect(result.ext).toBe("png");
    expect(result.contentType).toBe("image/png");
  });

  it("rejects corrupt bytes", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(render(data, medium, { width: 100, height: 100, format: "webp" })).rejects.toThrow();
  });

  it("rejects a truncated jpeg", async () => {
    const data = await jpeg(1200, 800);
    const truncated = data.slice(0, Math.floor(data.byteLength * 0.6));
    await expect(render(truncated, medium, { width: 1024, height: 683, format: "webp" })).rejects.toThrow();
  });
});

describe("render time limit", () => {
  it("stops a render that runs past the limit inside the image library", async () => {
    const side = 5000;
    const noisy = await sharp(randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const size: Size = { name: "big", width: side - 10, fit: "inside", format: "webp", quality: 80 };
    const started = performance.now();
    const outcome = await render(noisy, size, { width: side - 10, height: side - 10, format: "webp" }, { timeoutSeconds: 1 }).then(
      () => "finished",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome).toMatch(/timeout/);
    expect(performance.now() - started).toBeLessThan(2500);
  }, 30_000);
});
