import { describe, expect, it } from "vitest";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module from "./module.ts";

const deps: Deps = {
  get<T>(contract: Contract<T>): T {
    throw new Error(`no provider for "${contract.name}"`);
  },
  find: () => undefined,
  logger: silentLogger,
  root: process.cwd(),
};

async function boot() {
  return module.setup(module.configSchema.parse({ buckets: { login: { limit: 1, windowSeconds: 60 } } }), deps);
}

const checkPipeline = definePipeline({ name: "check", steps: ["ratelimit.check:login"] });
const sweepPipeline = definePipeline({ name: "sweep", steps: ["ratelimit.sweep"] });

describe("ratelimit/memory module steps via runPipeline", () => {
  it("check allows the first request per window and blocks the next with 429 RATE_LIMITED", async () => {
    const instance = await boot();
    const first = await runPipeline(checkPipeline, { ip: "1.2.3.4" }, { modules: [{ module, instance }] });
    expect(first.status).toBe(200);

    const second = await runPipeline(checkPipeline, { ip: "1.2.3.4" }, { modules: [{ module, instance }] });
    expect(second.status).toBe(429);
    expect(second.code).toBe("RATE_LIMITED");
    expect(second.details).toMatchObject({ retryAfterSeconds: 60 });
  });

  it("sweep reports the number of dropped windows", async () => {
    const instance = await boot();
    await runPipeline(checkPipeline, { ip: "1.2.3.4" }, { modules: [{ module, instance }] });
    const res = await runPipeline(sweepPipeline, {}, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect((res.result as { removed: number }).removed).toBe(0);
  });
});
