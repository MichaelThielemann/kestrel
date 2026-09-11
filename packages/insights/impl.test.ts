import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, silentLogger, type Kestrel } from "@michaelthielemann/kestrel";
import type { Context } from "@michaelthielemann/kestrel/context";
import { ok } from "@michaelthielemann/kestrel/result";
import { insightsContractTests } from "@michaelthielemann/kestrel-contracts/insights.contract.test";
import { createInsights, percentile } from "./impl.ts";
import module from "./module.ts";

const probe = defineModule({
  name: "probe/test",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    pass: async (ctx: Context) => ok({ ...ctx, result: "ok" }),
    deny: async (ctx: Context) => ctx.fail("FORBIDDEN", "no"),
    boom: async () => {
      throw new Error("bug");
    },
  }),
  describe: () => ({
    pass: { summary: "pass", reads: [], writes: ["result"] },
    deny: { summary: "deny", reads: [], writes: [] },
    boom: { summary: "boom", reads: [], writes: [] },
  }),
});

async function booted(): Promise<Kestrel> {
  return boot({
    config: {
      modules: [
        { use: "./probe.ts", config: {} },
        { use: "@michaelthielemann/kestrel-insights", config: {} },
      ],
      triggers: [{ http: "GET /pass", pipeline: "pass" }],
      http: null,
    },
    modules: [probe, module],
    pipelines: [definePipeline({ name: "pass", steps: ["probe.pass"] }), definePipeline({ name: "deny", steps: ["probe.deny"] }), definePipeline({ name: "boom", steps: ["probe.boom"] })],
    logger: silentLogger,
  });
}

const http = { kind: "http" as const, name: "GET /pass" };

insightsContractTests(async () => {
  const kestrel = await booted();
  return { insights: kestrel.contracts.get(module.provides[0]!) as ReturnType<typeof createInsights>, run: async () => void (await kestrel.run("pass", { trigger: http })), pipeline: "pass" };
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 0.95)).toBe(95);
  });
});

describe("insights aggregation", () => {
  it("counts ok, failed and errored runs per pipeline and per step", async () => {
    const kestrel = await booted();
    const insights = kestrel.contracts.get(module.provides[0]!) as ReturnType<typeof createInsights>;
    for (let i = 0; i < 3; i++) await kestrel.run("pass", { trigger: http });
    await kestrel.run("deny", { trigger: http });
    await kestrel.run("boom", { trigger: http });
    const stats = insights.stats();
    expect(stats.runs).toEqual({ active: 0, total: 5, failed: 2, errors: 1 });
    expect(stats.pipelines.map((p) => [p.name, p.count, p.failed, p.errors])).toEqual([
      ["boom", 1, 1, 1],
      ["deny", 1, 1, 0],
      ["pass", 3, 0, 0],
    ]);
    expect(stats.steps.map((s) => [s.pipeline, s.step, s.count, s.failed, s.errors])).toEqual([
      ["boom", "probe.boom", 1, 1, 1],
      ["deny", "probe.deny", 1, 1, 0],
      ["pass", "probe.pass", 3, 0, 0],
    ]);
    await kestrel.stop();
  });

  it("counts active runs while a pipeline is in flight", async () => {
    const insights = createInsights({ now: () => 1000, processStartedAt: 0 });
    insights.observer.runStart!({ runId: "r", pipeline: "p", trigger: http, at: 1000 });
    expect(insights.stats().runs.active).toBe(1);
    insights.observer.runEnd!({ runId: "r", pipeline: "p", trigger: http, at: 1000, ms: 5, status: 200, outcome: "ok" });
    expect(insights.stats().runs).toEqual({ active: 0, total: 1, failed: 0, errors: 0 });
    expect(insights.stats().pipelines[0]).toEqual({ name: "p", count: 1, failed: 0, errors: 0, p50Ms: 5, p95Ms: 5, lastAt: 1005 });
  });

  it("counts event-triggered runs per event name", async () => {
    const kestrel = await booted();
    const insights = kestrel.contracts.get(module.provides[0]!) as ReturnType<typeof createInsights>;
    await kestrel.run("pass", { trigger: { kind: "event", name: "thing.done" } });
    await kestrel.run("pass", { trigger: { kind: "event", name: "thing.done" } });
    await kestrel.run("pass", { trigger: http });
    const events = insights.stats().events;
    expect(events).toMatchObject([{ name: "thing.done", count: 2 }]);
    expect(typeof events[0]?.lastAt).toBe("number");
    await kestrel.stop();
  });

  it("keeps only the last sampleSize durations for the percentiles but every count", () => {
    const insights = createInsights({ now: () => 0, processStartedAt: 0, sampleSize: 4 });
    for (const ms of [100, 100, 100, 1, 2, 3, 4]) insights.observer.runEnd!({ runId: "r", pipeline: "p", trigger: http, at: 0, ms, status: 200, outcome: "ok" });
    expect(insights.stats().pipelines[0]).toMatchObject({ count: 7, p50Ms: 2, p95Ms: 4 });
  });

  it("reports process facts and uptime", () => {
    const insights = createInsights({ now: () => 5000, processStartedAt: 2000 });
    const stats = insights.stats();
    expect(stats.process).toEqual({ pid: process.pid, startedAt: 2000, uptimeMs: 3000 });
    expect(stats.generatedAt).toBe(5000);
    expect(stats.ratelimit).toEqual([]);
  });

  it("throws for manifest() before attach and stops observing after detach", async () => {
    const insights = createInsights();
    expect(() => insights.manifest()).toThrow("not attached");
    const kestrel = await booted();
    const attached = kestrel.contracts.get(module.provides[0]!) as ReturnType<typeof createInsights>;
    expect(attached.manifest().modules.map((m) => m.name)).toEqual(["probe/test", "insights/default"]);
    await kestrel.stop();
    await kestrel.run("pass", { trigger: http });
    expect(attached.stats().runs.total).toBe(0);
  });
});
