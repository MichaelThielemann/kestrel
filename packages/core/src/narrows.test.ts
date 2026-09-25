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

  const full = { id: "1", secret: "s", meta: { a: 1, b: 2 } };
  const validated = (steps: Parameters<typeof runPipeline>[0]["steps"]) => {
    const stacks: string[] = [];
    const logger: Logger = { ...silentLogger, error: (_message, meta) => stacks.push(String(meta?.stack)) };
    return runPipeline({ name: "p", steps }, input, logger, {}, { validateOutput: true }).then((res) => ({ res, log: stacks.join("\n") }));
  };

  it("under validateOutput, passes an answer that lost members the schema requires", async () => {
    const { res } = await validated([producer(full), narrower(() => ({ id: "1", meta: { a: 1 } }))]);
    expect(res).toMatchObject({ status: 200, result: { id: "1", meta: { a: 1 } } });
  });

  it("under validateOutput, rejects a narrowing step that invents an answer where there was none", async () => {
    const silent = { name: "produce", description: { summary: "p", reads: [], writes: ["result?"], output: ITEM }, fn: async (ctx: Context) => ok(ctx) };
    const { res, log } = await validated([silent, narrower(() => ({ id: "1" }))]);
    expect(res.status).toBe(500);
    expect(log).toContain('step "cut" declares narrows but changed $');
    expect(log).not.toContain("result before it");
  });

  it("under validateOutput, narrows an answer read as a row without a prototype into a plain object, and back", async () => {
    const bare = (members: Record<string, unknown>): Record<string, unknown> => {
      const empty: unknown = Object.create(null);
      return Object.assign(boundaryCast<Record<string, unknown>>(empty, "host"), members);
    };
    const row = bare({ id: "1", secret: "s", meta: bare({ a: 1, b: 2 }) });
    const toPlain = await validated([producer(row), narrower(() => ({ id: "1", meta: { a: 1 } }))]);
    expect(toPlain.res).toMatchObject({ status: 200, result: { id: "1", meta: { a: 1 } } });
    const toRow = await validated([producer(full), narrower(() => bare({ id: "1" }))]);
    expect(toRow.res.status).toBe(200);
    const added = await validated([producer(row), narrower(() => ({ id: "1", extra: true }))]);
    expect(added.log).toContain('step "cut" declares narrows but added $.extra');
  });

  it("under validateOutput, rejects a narrowed answer that changes a kept value", async () => {
    const { res, log } = await validated([producer(full), narrower(() => ({ id: 1 }))]);
    expect(res.status).toBe(500);
    expect(log).toContain('step "cut" declares narrows but changed $.id');
  });

  it("under validateOutput, rejects a narrowed answer that adds a member, at any depth", async () => {
    for (const cut of [() => ({ id: "1", extra: true }), () => ({ id: "1", meta: { a: 1, c: 3 } })]) {
      const { res, log } = await validated([producer(full), narrower(cut)]);
      expect(res.status).toBe(500);
      expect(log).toMatch(/step "cut" declares narrows but added \$\.(extra|meta\.c)/);
    }
  });

  it("under validateOutput, rejects a narrowed list that drops or adds an element", async () => {
    const LIST = { type: "object", properties: { items: { type: "array", items: ITEM }, total: { type: "number" } }, required: ["items", "total"] };
    const list = { name: "list", description: { summary: "l", reads: [], writes: ["result"], output: LIST }, fn: async (ctx: Context) => ok({ ...ctx, result: { items: [full, full], total: 2 } }) };
    const listCut = (cut: (value: unknown) => unknown) => ({ ...narrower(cut), description: { summary: "c", reads: ["result"], writes: ["result?"], narrows: { ...NARROWS, shape: "list" as const } } });
    expect((await validated([list, listCut(() => ({ items: [{ id: "1" }, { id: "1" }], total: 2 }))])).res.status).toBe(200);
    const dropped = await validated([list, listCut(() => ({ items: [{ id: "1" }], total: 2 }))]);
    expect(dropped.res.status).toBe(500);
    expect(dropped.log).toContain('step "cut" declares narrows but changed the length of $.items');
  });

  it("under validateOutput, narrows an answer whose declared output is a oneOf of objects", async () => {
    const ONE_OF = { oneOf: [{ type: "object", properties: { kind: { const: "a" }, id: { type: "string" }, secret: { type: "string" } }, required: ["kind", "id", "secret"] }, { type: "object", properties: { kind: { const: "b" }, id: { type: "string" } }, required: ["kind", "id"] }] };
    const produce = { name: "produce", description: { summary: "p", reads: [], writes: ["result"], output: ONE_OF }, fn: async (ctx: Context) => ok({ ...ctx, result: { kind: "a", id: "1", secret: "s" } }) };
    const { res } = await validated([produce, narrower(() => ({ id: "1" }))]);
    expect(res).toMatchObject({ status: 200, result: { id: "1" } });
  });

  it("under validateOutput, validates a step after the narrowing step against the full declared output", async () => {
    const extend = { name: "extend", description: { summary: "e", reads: ["result"], writes: ["result.extra"], extendsOutput: { type: "object", properties: { extra: { type: "boolean" } }, required: ["extra"] } }, fn: async (ctx: Context) => ok({ ...ctx, result: { ...boundaryCast<Record<string, unknown>>(ctx.result, "host"), extra: true } }) };
    const { res, log } = await validated([producer(full), narrower(() => ({ id: "1" })), extend]);
    expect(res.status).toBe(500);
    expect(log).toContain('step "extend": result does not match describe().output');
  });

  it("without narrows, the same cut answer fails validateOutput", async () => {
    const plain = { name: "cut", description: { summary: "c", reads: ["result"], writes: ["result"], output: ITEM }, fn: async (ctx: Context) => ok({ ...ctx, result: { id: "1" } }) };
    const res = await runPipeline({ name: "p", steps: [producer({ id: "1", secret: "s", meta: { a: 1, b: 2 } }), plain] }, input, silentLogger, {}, { validateOutput: true });
    expect(res.status).toBe(500);
  });
});
