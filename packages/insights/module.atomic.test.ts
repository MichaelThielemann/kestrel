import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AtomicOutcome, AtomicScopeInfo, AtomicVerdict } from "@michaelthielemann/kestrel/atomic";
import { boot } from "@michaelthielemann/kestrel";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import insightsModule from "./module.ts";

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
  }),
  describe: () => ({
    safe: { summary: "safe", reads: [], writes: [], atomicSafe: true },
  }),
  atomicScope: async (_instance, info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome> => ({
    kind: "settled",
    verdict: await body(),
  }),
});

describe("the manifest of a grouped instance validates against insights.readManifest's output schema", () => {
  it("boots a grouped instance and reads a valid manifest", async () => {
    const pipelines = [
      definePipeline({ name: "grouped", steps: [{ atomic: ["store.safe"] }] }),
      definePipeline({ name: "readManifest", steps: ["insights.readManifest"] }),
    ];
    const kestrel = await boot({
      config: { modules: [{ use: "store" }, { use: "insights" }], triggers: [] },
      modules: [store, insightsModule],
      pipelines,
      logger: silentLogger,
      validateOutput: true,
    });
    const res = await kestrel.run("readManifest", { trigger: { kind: "http", name: "test" }, payload: {} });
    expect(res.status).toBe(200);
    await kestrel.stop();
  });
});
