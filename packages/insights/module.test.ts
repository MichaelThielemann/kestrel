import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, silentLogger } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";

const deps: Deps = {
  get<T>(contract: Contract<T>): T {
    throw new Error(`no provider for "${contract.name}"`);
  },
  find: () => undefined,
  logger: silentLogger,
  root: process.cwd(),
};

const manifestPipeline = definePipeline({ name: "insightsManifest", steps: ["insights.readManifest"] });
const statsPipeline = definePipeline({ name: "insightsStats", steps: ["insights.readStats"] });

const probe = defineModule({
  name: "probe/test",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({ pass: async (ctx: Context) => ok(ctx) }),
  describe: () => ({ pass: { summary: "pass", reads: [], writes: [] } }),
});

describe("insights/default module steps via runPipeline", () => {
  it("accepts the empty config and a ring buffer size", () => {
    expect(configSchema.parse({})).toEqual({ recentFailures: 50 });
    expect(configSchema.safeParse({ recentFailures: 10 }).success).toBe(true);
    expect(configSchema.safeParse({ recentFailures: -1 }).success).toBe(false);
    expect(configSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("readStats answers the live counters", async () => {
    const instance = await module.setup(configSchema.parse({}), deps);
    const res = await runPipeline(statsPipeline, {}, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ runs: { active: 0, total: 0, failed: 0, errors: 0 }, pipelines: [], steps: [], events: [], ratelimit: [], recentFailures: [] });
  });

  it("readManifest outside a booted instance is a wiring error", async () => {
    const instance = await module.setup(configSchema.parse({}), deps);
    const res = await runPipeline(manifestPipeline, {}, { modules: [{ module, instance }] });
    expect(res).toMatchObject({ status: 500, code: "INTERNAL" });
  });

  it("readManifest answers the manifest with generatedAt once booted, readStats sees the runs", async () => {
    const kestrel = await boot({
      config: { modules: [{ use: "./probe.ts", config: {} }, { use: "@michaelthielemann/kestrel-insights", config: {} }], triggers: [{ http: "GET /pass", pipeline: "pass" }], http: null },
      modules: [probe, module],
      pipelines: [definePipeline({ name: "pass", steps: ["probe.pass"] }), manifestPipeline, statsPipeline],
      logger: silentLogger,
    });
    const trigger = { kind: "http" as const, name: "GET /x" };
    await kestrel.run("pass", { trigger });
    const manifest = await kestrel.run("insightsManifest", { trigger });
    expect(manifest.status).toBe(200);
    expect(typeof boundaryCast<{ generatedAt: unknown }>(manifest.result, "json").generatedAt).toBe("number");
    expect(manifest.result).toMatchObject({ modules: [{ name: "probe/test" }, { name: "insights/default", provides: ["insights@1"], config: { variables: [{ path: "recentFailures", type: "integer", required: false, default: 50 }] } }], triggers: { http: [{ method: "GET", path: "/pass", pipeline: "pass" }] } });
    const stats = await kestrel.run("insightsStats", { trigger });
    expect(stats.result).toMatchObject({ runs: { total: 2 }, pipelines: [{ name: "insightsManifest", count: 1 }, { name: "pass", count: 1 }] });
    await kestrel.stop();
  });
});
