import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AtomicOutcome, AtomicScopeInfo, AtomicVerdict } from "./atomic.ts";
import { boot } from "./boot.ts";
import type { Context } from "./context.ts";
import { defineModule } from "./defineModule.ts";
import { definePipeline } from "./definePipeline.ts";
import { KestrelBootError } from "./errors.ts";
import { silentLogger } from "./logger.ts";
import { ok } from "./result.ts";

function realScope() {
  return async (_info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome> => ({
    kind: "settled",
    verdict: await body(),
  });
}

const store = defineModule({
  name: "store/memory",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    safe: async (ctx: Context) => ok(ctx),
    unsafe: async (ctx: Context) => ok(ctx),
  }),
  describe: () => ({
    safe: { summary: "safe", reads: [], writes: [], atomicSafe: true },
    unsafe: { summary: "unsafe", reads: [], writes: [] },
  }),
  atomicScope: (_instance, info, body) => realScope()(info, body),
});

const storeNoScope = defineModule({
  name: "store/memory",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    safe: async (ctx: Context) => ok(ctx),
  }),
  describe: () => ({
    safe: { summary: "safe", reads: [], writes: [], atomicSafe: true },
  }),
});

describe("boot: atomic groups", () => {
  it("a step inside a group without atomicSafe fails boot, naming pipeline and step", async () => {
    const pipelines = [definePipeline({ name: "p", steps: [{ atomic: ["store.safe", "store.unsafe"] }] })];
    await expect(boot({ config: { modules: [{ use: "store" }], triggers: [] }, modules: [store], pipelines, logger: silentLogger })).rejects.toThrow(
      new KestrelBootError("pipelines/p", 'step "store.unsafe" is in an atomic group but does not declare atomicSafe', "atomic-unsafe-step"),
    );
  });

  it("a grouped pipeline with no scope provider fails boot, naming the pipeline", async () => {
    const pipelines = [definePipeline({ name: "p", steps: [{ atomic: ["store.safe"] }] })];
    await expect(boot({ config: { modules: [{ use: "store" }], triggers: [] }, modules: [storeNoScope], pipelines, logger: silentLogger })).rejects.toThrow(
      new KestrelBootError("kestrel", 'pipeline "p" has an atomic group but no module provides an atomic scope', "atomic-scope-missing"),
    );
  });

  it("two modules providing an atomic scope fails boot, naming both", async () => {
    const second = defineModule({ ...store, name: "second/memory" });
    const pipelines = [definePipeline({ name: "p", steps: [{ atomic: ["store.safe"] }] })];
    await expect(
      boot({ config: { modules: [{ use: "store" }, { use: "second" }], triggers: [] }, modules: [store, second], pipelines, logger: silentLogger }),
    ).rejects.toThrow(new KestrelBootError("kestrel", 'modules "store/memory" and "second/memory" both provide an atomic scope', "atomic-scope-twice"));
  });

  it("no group, no scope provider, no behaviour change", async () => {
    const pipelines = [definePipeline({ name: "p", steps: ["store.safe"] })];
    const kestrel = await boot({ config: { modules: [{ use: "store" }], triggers: [] }, modules: [storeNoScope], pipelines, logger: silentLogger });
    const res = await kestrel.run("p", { trigger: { kind: "http", name: "test" }, payload: {} });
    expect(res.status).toBe(200);
    await kestrel.stop();
  });

  it("Nit: an atomicSafe violation is reported before a trigger error", async () => {
    const pipelines = [definePipeline({ name: "p", steps: [{ atomic: ["store.safe", "store.unsafe"] }] })];
    await expect(
      boot({
        config: { modules: [{ use: "store" }], triggers: [{ http: "GET /x", pipeline: "unknown-pipeline" }] },
        modules: [store],
        pipelines,
        logger: silentLogger,
      }),
    ).rejects.toThrow(new KestrelBootError("pipelines/p", 'step "store.unsafe" is in an atomic group but does not declare atomicSafe', "atomic-unsafe-step"));
  });

  it("the normal case: one provider, a grouped pipeline runs through the scope", async () => {
    const pipelines = [definePipeline({ name: "p", steps: [{ atomic: ["store.safe"] }] })];
    const kestrel = await boot({ config: { modules: [{ use: "store" }], triggers: [] }, modules: [store], pipelines, logger: silentLogger });
    const res = await kestrel.run("p", { trigger: { kind: "http", name: "test" }, payload: {} });
    expect(res.status).toBe(200);
    await kestrel.stop();
  });
});
