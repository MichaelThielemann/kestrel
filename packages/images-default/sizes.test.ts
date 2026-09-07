import { describe, expect, it } from "vitest";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { DEFAULT_SIZES, extOf, mergeSizes, sizeSchema, spec } from "./sizes.ts";
import type { Size } from "./sizes.ts";

describe("sizeSchema", () => {
  it("applies defaults for fit, format and quality", () => {
    const parsed = sizeSchema.parse({ name: "thumb", width: 320 });
    expect(parsed).toEqual({ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 });
  });

  it("rejects a bad name", () => {
    expect(() => sizeSchema.parse({ name: "Thumb!", width: 320 })).toThrow();
  });

  it("rejects cover without height", () => {
    expect(() => sizeSchema.parse({ name: "thumb", width: 320, fit: "cover" })).toThrow();
  });

  it("accepts cover with height", () => {
    const parsed = sizeSchema.parse({ name: "thumb", width: 320, height: 200, fit: "cover" });
    expect(parsed).toMatchObject({ width: 320, height: 200, fit: "cover" });
  });

  it("rejects quality 0", () => {
    expect(() => sizeSchema.parse({ name: "thumb", width: 320, quality: 0 })).toThrow();
  });
});

describe("mergeSizes", () => {
  const config: Size[] = [{ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 }];

  it("registered overrides default with source registered", () => {
    const registered: Size[] = [{ name: "thumb", width: 300, fit: "inside", format: "webp", quality: 82 }];
    const rows = expectOk(mergeSizes(DEFAULT_SIZES, "default", registered));
    const thumb = rows.find((r) => r.name === "thumb");
    expect(thumb).toMatchObject({ width: 300, source: "registered" });
  });

  it("registered equal to config passes with source registered", () => {
    const rows = expectOk(mergeSizes(config, "config", [{ ...config[0]! }]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...config[0]!, source: "registered" });
    expect(typeof rows[0]!.updatedAt).toBe("number");
  });

  it("registered differing from config answers CONFLICT naming the size", () => {
    const registered: Size[] = [{ name: "thumb", width: 999, fit: "inside", format: "webp", quality: 82 }];
    const error = expectErr(mergeSizes(config, "config", registered), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toContain("thumb");
  });

  it("base sizes not overridden keep their base source", () => {
    const rows = expectOk(mergeSizes(DEFAULT_SIZES, "default", []));
    expect(rows.every((r) => r.source === "default")).toBe(true);
    expect(rows).toHaveLength(DEFAULT_SIZES.length);
  });
});

describe("spec", () => {
  it("formats width, height, fit, format and quality", () => {
    expect(spec({ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 })).toBe("320x:inside:webp:82");
  });

  it("includes height when set", () => {
    expect(spec({ name: "thumb", width: 320, height: 200, fit: "cover", format: "webp", quality: 82 })).toBe("320x200:cover:webp:82");
  });
});

describe("extOf", () => {
  const base: Size = { name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 };

  it("is webp for format webp", () => {
    expect(extOf(base, "jpeg")).toBe("webp");
  });

  it("maps jpeg to jpg for format original", () => {
    expect(extOf({ ...base, format: "original" }, "jpeg")).toBe("jpg");
  });

  it("keeps png for format original", () => {
    expect(extOf({ ...base, format: "original" }, "png")).toBe("png");
  });
});
