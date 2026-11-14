import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { ModuleDefinition } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { projectSvgSanitizer } from "./svgSanitizer.ts";

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
});
