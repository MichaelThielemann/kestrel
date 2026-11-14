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

function otherSanitizeModule(described: boolean): { module: ModuleDefinition; setups: string[] } {
  const setups: string[] = [];
  const module = boundaryCast<ModuleDefinition>(
    {
      name: "sanitize/html",
      provides: [],
      requires: [],
      configSchema: z.object({ strict: z.boolean() }).strict(),
      setup: () => {
        setups.push("sanitize/html");
        return Promise.reject(new Error("needs the contract persistence@1"));
      },
      steps: () => ({ html: (ctx: Context) => Promise.resolve(ok(ctx)) }),
      ...(described ? { describe: () => ({ html: { summary: "cleans HTML", reads: ["files"], writes: ["files"] } }) } : {}),
    },
    "host",
  );
  return { module, setups };
}

function sanitizeModule(configSchema: unknown, answer: (data: Uint8Array) => Uint8Array = (data) => data): ModuleDefinition {
  return boundaryCast<ModuleDefinition>(
    {
      name: "sanitize/test",
      provides: [],
      requires: [],
      configSchema,
      setup: () => Promise.resolve({}),
      steps: () => ({ svg: (ctx: Context) => Promise.resolve(ok({ ...ctx, files: ctx.files.map((f) => ({ ...f, data: answer(f.data) })) })) }),
      describe: () => ({ svg: { summary: "cleans SVG files", reads: ["files"], writes: ["files"] } }),
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
  it("neither parses the config of nor sets up a sanitize module whose steps do not include svg, and takes the sanitize.svg module after it", async () => {
    const other = otherSanitizeModule(true);
    const found = await projectSvgSanitizer(tmpdir(), [
      { use: "./sanitize-html.ts", config: { strict: "yes" }, definition: () => Promise.resolve(other.module) },
      { use: "./svg-cleaner.ts", config: {}, definition: () => Promise.resolve(sanitizeModule(z.object({}).strict())) },
    ]);
    expect(found.broken).toBeUndefined();
    expect(found.from).toBe("./svg-cleaner.ts");
    expect(found.sanitize).toBeDefined();
    expect(other.setups).toEqual([]);
  });

  it("counts a sanitize module whose steps it can only learn by setting it up, and which cannot be set up offline, as not loaded instead of as the sanitize.svg module", async () => {
    const other = otherSanitizeModule(false);
    const before = await projectSvgSanitizer(tmpdir(), [
      { use: "./sanitize-html.ts", config: { strict: true }, definition: () => Promise.resolve(other.module) },
      { use: "./svg-cleaner.ts", config: {}, definition: () => Promise.resolve(sanitizeModule(z.object({}).strict())) },
    ]);
    expect(before.broken).toBeUndefined();
    expect(before.from).toBe("./svg-cleaner.ts");
    const alone = await projectSvgSanitizer(tmpdir(), [{ use: "./sanitize-html.ts", config: { strict: true }, definition: () => Promise.resolve(other.module) }]);
    expect(alone.broken).toBeUndefined();
    expect(alone.sanitize).toBeUndefined();
    expect(alone.unloaded).toContain("./sanitize-html.ts could not be set up offline");
  });
});
