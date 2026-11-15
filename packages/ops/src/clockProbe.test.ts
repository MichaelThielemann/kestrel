import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironments } from "./environments.ts";
import { createHarness, LOCATION } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import type { Output } from "./output.ts";
import { appClock, serverClock } from "./serverTime.ts";
import type { ObjectStore } from "./store.ts";
import { createUpdateHarness, type UpdateHarness } from "./update/harness.fixture.ts";
import { deploy } from "./update/deploy.ts";
import { UPDATE_EXIT } from "./update/types.ts";

const accessDenied = (): Error => Object.assign(new Error("Access Denied."), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });

const isProbe = (key: string): boolean => key.includes("/probes/") || key.includes("/.kestrel-clock/");

function refusingProbeDeletes(store: ObjectStore): ObjectStore {
  return {
    ...store,
    delete: async (key) => {
      if (isProbe(key)) throw accessDenied();
      return store.delete(key);
    },
  };
}

function collecting(): { out: Output; warnings: string[] } {
  const warnings: string[] = [];
  return { out: { info: () => undefined, warn: (line) => warnings.push(line), error: () => undefined }, warnings };
}

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

describe("the clock probe of a key that may not delete it", () => {
  it("still measures the store's clock and warns once per command, naming the probe and backup prune", async () => {
    const bucket = new MemoryBucket("clock-probe");
    const store = refusingProbeDeletes(memoryStore(bucket));
    const { out, warnings } = collecting();
    const h = createHarness({ store });
    const env = loadEnvironments(h.root).prod;
    await h.dispose();
    if (env === undefined) throw new Error("the harness environment is missing");
    const ctx = { app: store, env, location: LOCATION, runId: "a1b2c3", clock: Date.now, poll: { delayMs: 5, attempts: 50 }, out };
    const first = await appClock(ctx);
    const second = await appClock(ctx);
    expect(Math.abs(first.skewMs)).toBeLessThan(5_000);
    expect(Math.abs(second.skewMs)).toBeLessThan(5_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${LOCATION}probes/a1b2c3-`);
    expect(warnings[0]).toContain("backup prune");
    expect([...bucket.objects.keys()].filter(isProbe)).toHaveLength(2);
  });

  it("warns for a probe the store's own clock measurement could not delete", async () => {
    const store: ObjectStore = { ...memoryStore(new MemoryBucket("clock-own")), serverTime: async (prefix) => ({ skewMs: 120, leftover: `${prefix}.kestrel-clock/6c1d` }) };
    const { out, warnings } = collecting();
    const clock = await serverClock(store, LOCATION, "d4e5f6", Date.now, {}, out);
    expect(clock.skewMs).toBe(120);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${LOCATION}.kestrel-clock/6c1d`);
  });

  it("lets a deploy promote, start and verify the release", async () => {
    const bucket = new MemoryBucket("clock-deploy");
    const h = createUpdateHarness({ store: refusingProbeDeletes(memoryStore(bucket)), from: { runtime: "6.0.0" } });
    harnesses.push(h);
    await h.target.start();
    await h.target.app?.seed();
    const ctx = await h.context({ answers: { "update-stop": "accept" } });
    const outcome = await deploy(ctx);
    expect(outcome.exitCode, outcome.message).toBe(UPDATE_EXIT.done);
    expect(outcome.state).toBe("verified");
    expect(h.output.warn.filter((line) => line.includes("clock probe"))).toHaveLength(1);
  });

  it("is removed by backup prune once it is older than an hour", async () => {
    let now = Date.parse("2026-10-01T00:00:00Z");
    const bucket = new MemoryBucket("clock-prune", { clock: () => now });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      bucket.write(`${LOCATION}probes/0a1b2c-9f8e`, new TextEncoder().encode("1"), "put");
      bucket.write(`${LOCATION}.kestrel-clock/4d5e6f`, new Uint8Array(), "put");
      now += 30 * 60 * 1000;
      bucket.write(`${LOCATION}probes/0a1b2c-7d6c`, new TextEncoder().encode("2"), "put");
      now += 40 * 60 * 1000;
      const dry = await h.run(["backup", "prune", "--dry-run", "--json"], { clock: () => now });
      expect(dry.code, dry.stderr).toBe(0);
      expect(bucket.objects.has(`${LOCATION}probes/0a1b2c-9f8e`)).toBe(true);
      const pruned = await h.run(["backup", "prune", "--yes", "--json"], { clock: () => now });
      expect(pruned.code, pruned.stderr).toBe(0);
      expect(bucket.objects.has(`${LOCATION}probes/0a1b2c-9f8e`)).toBe(false);
      expect(bucket.objects.has(`${LOCATION}.kestrel-clock/4d5e6f`)).toBe(false);
      expect(bucket.objects.has(`${LOCATION}probes/0a1b2c-7d6c`)).toBe(true);
    } finally {
      await h.dispose();
    }
  });
});
