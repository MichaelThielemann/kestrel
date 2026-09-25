import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot } from "./boot.ts";
import { boundaryCast } from "./cast.ts";
import type { Context } from "./context.ts";
import { defineModule, type NarrowsDeclaration, type StepDescription } from "./defineModule.ts";
import { definePipeline } from "./definePipeline.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { ok } from "./result.ts";
import { resolveOutputSchema } from "./schema.ts";
import { runPipeline } from "./runner.ts";

const ITEM = {
  type: "object",
  properties: { id: { type: "string" }, secret: { type: "string" }, meta: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  required: ["id", "secret", "meta"],
};
const NARROWS: NarrowsDeclaration = { shape: "item", answers: { visitor: ["id", "meta.a"] } };
const input = { trigger: { kind: "http" as const, name: "GET /x" } };

function producer(value: unknown) {
  return { name: "produce", description: { summary: "p", reads: [], writes: ["result"], output: ITEM }, fn: async (ctx: Context) => ok({ ...ctx, result: value }) };
}

function narrower(cut: (value: unknown) => unknown) {
  return { name: "cut", description: { summary: "c", reads: ["result"], writes: ["result?"], narrows: NARROWS }, fn: async (ctx: Context) => ok({ ...ctx, result: cut(ctx.result) }) };
}

describe("a step declaring narrows", () => {
  it("counts as a declaration of its result write at boot", async () => {
    const mod = defineModule({
      name: "cutter/one",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ produce: async (ctx: Context) => ok({ ...ctx, result: { id: "1", secret: "s", meta: { a: 1, b: 2 } } }), cut: async (ctx: Context) => ok(ctx) }),
      describe: () => ({
        produce: { summary: "p", reads: [], writes: ["result"], output: ITEM },
        cut: { summary: "c", reads: ["result"], writes: ["result"], narrows: NARROWS },
      }),
    });
    const kestrel = await boot({ config: { modules: [{ use: "./cutter", config: {} }], triggers: [], http: null }, modules: [mod], pipelines: [definePipeline({ name: "read", steps: ["cutter.produce", "cutter.cut"] })], logger: silentLogger });
    expect(kestrel.describe().pipelines[0]?.steps[1]?.description.narrows).toEqual(NARROWS);
    await kestrel.stop();
  });

  it("leaves the folded output schema as it was", () => {
    const before: StepDescription = { summary: "p", reads: [], writes: ["result"], output: ITEM };
    const cut: StepDescription = { summary: "c", reads: [], writes: ["result"], narrows: NARROWS };
    expect(resolveOutputSchema([before, cut])).toEqual(ITEM);
  });

  it("under validateOutput, passes an answer that lost members the schema requires", async () => {
    const res = await runPipeline({ name: "p", steps: [producer({ id: "1", secret: "s", meta: { a: 1, b: 2 } }), narrower(() => ({ id: "1", meta: { a: 1 } }))] }, input, silentLogger, {}, { validateOutput: true });
    expect(res).toMatchObject({ status: 200, result: { id: "1", meta: { a: 1 } } });
  });

  it("under validateOutput, still rejects a kept member of the wrong type", async () => {
    const stacks: string[] = [];
    const logger: Logger = { ...silentLogger, error: (_message, meta) => stacks.push(String(meta?.stack)) };
    const res = await runPipeline({ name: "p", steps: [producer({ id: "1", secret: "s", meta: { a: 1, b: 2 } }), narrower(() => ({ id: 1 }))] }, input, logger, {}, { validateOutput: true });
    expect(res.status).toBe(500);
    expect(stacks.join("\n")).toContain('step "cut": result does not match describe().output ($.id expected string, got number)');
  });

  it("under validateOutput, a step folding after it validates the narrowed answer without the removed members", async () => {
    const extend = { name: "extend", description: { summary: "e", reads: ["result"], writes: ["result.extra"], extendsOutput: { type: "object", properties: { extra: { type: "boolean" } }, required: ["extra"] } }, fn: async (ctx: Context) => ok({ ...ctx, result: { ...boundaryCast<Record<string, unknown>>(ctx.result, "host"), extra: true } }) };
    const res = await runPipeline({ name: "p", steps: [producer({ id: "1", secret: "s", meta: { a: 1, b: 2 } }), narrower(() => ({ id: "1" })), extend] }, input, silentLogger, {}, { validateOutput: true });
    expect(res).toMatchObject({ status: 200, result: { id: "1", extra: true } });
  });

  it("without narrows, the same cut answer fails validateOutput", async () => {
    const plain = { name: "cut", description: { summary: "c", reads: ["result"], writes: ["result"], output: ITEM }, fn: async (ctx: Context) => ok({ ...ctx, result: { id: "1" } }) };
    const res = await runPipeline({ name: "p", steps: [producer({ id: "1", secret: "s", meta: { a: 1, b: 2 } }), plain] }, input, silentLogger, {}, { validateOutput: true });
    expect(res.status).toBe(500);
  });
});
