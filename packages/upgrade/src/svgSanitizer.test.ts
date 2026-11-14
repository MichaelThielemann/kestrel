import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { ModuleDefinition } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { projectSvgSanitizer } from "./svgSanitizer.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const FILE = { filename: "mark.svg", contentType: "image/svg+xml", data: encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>') };

function sanitizeModule(configSchema: unknown, answer: (data: Uint8Array) => Uint8Array = (data) => data): ModuleDefinition {
  return boundaryCast<ModuleDefinition>(
    {
      name: "sanitize/test",
      provides: [],
      requires: [],
      configSchema,
      setup: () => Promise.resolve({}),
      steps: () => ({ svg: (ctx: Context) => Promise.resolve(ok({ ...ctx, files: ctx.files.map((f) => ({ ...f, data: answer(f.data) })) })) }),
    },
    "host",
  );
}

describe("the project's sanitize.svg in kestrel upgrade migrate", () => {
  it("cleans with a module whose config schema is a zod 4 schema", async () => {
    const found = await projectSvgSanitizer(tmpdir(), [{ use: "./svg-cleaner.ts", config: {}, definition: () => Promise.resolve(sanitizeModule(z.object({}).strict())) }]);
    expect(found.broken).toBeUndefined();
    expect(found.from).toBe("./svg-cleaner.ts");
    expect(found.sanitize).toBeDefined();
  });

  it("refuses a module whose config schema kestrel does not read, as start-up does, instead of cleaning with it", async () => {
    const olderSchema = { safeParse: (value: unknown) => ({ success: true, data: value }) };
    const found = await projectSvgSanitizer(tmpdir(), [{ use: "@example/older-sanitizer", config: {}, definition: () => Promise.resolve(sanitizeModule(olderSchema)) }]);
    expect(found.sanitize).toBeUndefined();
    expect(found.from).toBe("@example/older-sanitizer");
    expect(found.broken).toContain("not a zod 4 schema");
    expect(found.broken).toContain("install the project's 6.x dependencies first");
  });

  it("keeps a cleaned SVG whose root element is in the SVG namespace", async () => {
    for (const root of ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">', "<svg viewBox='0 0 1 1'\n xmlns = 'http://www.w3.org/2000/svg'>"]) {
      const answer = encode(`${root}<rect width="1" height="1"></rect></svg>`);
      const { sanitize } = await projectSvgSanitizer(tmpdir(), [{ use: "./svg-cleaner.ts", config: {}, definition: () => Promise.resolve(sanitizeModule(z.object({}).strict(), () => answer)) }]);
      const cleaned = await sanitize!(FILE);
      expect(isErr(cleaned), root).toBe(false);
    }
  });

  it("refuses a cleaned SVG whose root element is not in the SVG namespace, which no browser shows as an image", async () => {
    for (const root of ['<svg xmlns="&amp;ns_svg;" viewBox="0 0 1 1">', '<svg viewBox="0 0 1 1">', '<svg xmlns:a="http://www.w3.org/2000/svg">', "<g>"]) {
      const answer = encode(`${root}<rect width="1" height="1"></rect></svg>`);
      const { sanitize } = await projectSvgSanitizer(tmpdir(), [{ use: "./svg-cleaner.ts", config: {}, definition: () => Promise.resolve(sanitizeModule(z.object({}).strict(), () => answer)) }]);
      const cleaned = await sanitize!(FILE);
      expect(isErr(cleaned) ? cleaned.error : "kept", root).toContain("not in the SVG namespace");
    }
  });
});
