import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironments, updateSettings, UPDATE_DEFAULTS, type Environment } from "../environments.ts";
import { localTarget } from "../target.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { isUpdateTarget } from "./target.ts";

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const harness = (...args: Parameters<typeof createUpdateHarness>): UpdateHarness => {
  const h = createUpdateHarness(...args);
  harnesses.push(h);
  return h;
};

describe("the stand-in update target", () => {
  it("implements the update interface, which the local target does not", async () => {
    const h = harness();
    expect(isUpdateTarget(h.target)).toBe(true);
    expect(isUpdateTarget(await localTarget({ dir: ".", database: "db", command: ["true"], disk: "ephemeral" }, { root: h.root, clock: Date.now }))).toBe(false);
  });

  it("stages while the app keeps running and leaves it running when staging fails", async () => {
    const h = harness();
    await h.target.start();
    h.target.failStaging = "buildpack error";
    await expect(h.target.stage({ dir: h.releaseDir })).rejects.toThrow("staging failed: buildpack error");
    expect((await h.target.status()).state).toBe("started");
    h.target.failStaging = null;
    const staged = await h.target.stage({ dir: h.releaseDir });
    expect((await h.target.status()).state).toBe("started");
    expect((await h.target.listDroplets()).map((d) => d.guid)).toContain(staged.droplet);
    expect(h.target.actions).toEqual(["start", "stage", "stage"]);
  });

  it("answers readiness in the three outcomes and records a crash as no running instance", async () => {
    for (const [ready, outcome] of [["ready", "ready"], ["not-ready", "not-ready"], ["forbidden", "unverifiable"], ["unreachable", "unverifiable"]] as const) {
      const h = harness({ from: { runtime: "6.0.0", ready } });
      await h.target.start();
      expect((await h.target.probeReady()).outcome, ready).toBe(outcome);
    }
    const crashing = harness({ from: { runtime: "6.0.0", crashes: true } });
    const since = Date.now();
    await crashing.target.start();
    expect(await crashing.target.waitReady()).toBe(false);
    expect((await crashing.target.status()).instances).toBe(0);
    expect(await crashing.target.crashEvents(since)).toHaveLength(1);
  });

  it("restores a recorded configuration verbatim and reports a secret whose value it cannot know", async () => {
    const h = harness({ to: { env: { KESTREL_MIGRATIONS: "check", ADDED: "1", TOKEN: "rotated" } } });
    Object.assign(h.target.configuration.env, { KESTREL_MIGRATIONS: "apply", TOKEN: "first-secret-value", KEY: "kept-secret-value" });
    const recorded = await h.target.readConfiguration(new Set(["TOKEN", "KEY"]));
    expect(JSON.stringify(recorded)).not.toContain("secret-value");
    await h.target.applyReleaseConfiguration({ dir: h.releaseDir });
    expect(h.target.configuration.env).toMatchObject({ KESTREL_MIGRATIONS: "check", ADDED: "1", TOKEN: "rotated" });
    const restored = await h.target.restoreConfiguration(recorded);
    expect(restored).toEqual({ set: ["KESTREL_MIGRATIONS"], removed: ["ADDED"], unchanged: ["KEY"], unrestorable: ["TOKEN"] });
    expect(h.target.configuration.env).toEqual({ KESTREL_MIGRATIONS: "apply", TOKEN: "rotated", KEY: "kept-secret-value" });
  });

  it("refuses to swap or reconfigure a running app and never deletes the current droplet", async () => {
    const h = harness();
    const staged = await h.target.stage({ dir: h.releaseDir });
    await h.target.start();
    await expect(h.target.setDroplet(staged.droplet)).rejects.toThrow("while the app runs");
    await expect(h.target.restoreConfiguration(await h.target.readConfiguration(new Set()))).rejects.toThrow("while the app runs");
    await h.target.stop();
    const previous = h.target.current;
    await h.target.setDroplet(staged.droplet);
    await expect(h.target.deleteDroplet(staged.droplet)).rejects.toThrow("current droplet");
    await h.target.deleteDroplet(previous);
    expect((await h.target.listDroplets()).map((d) => d.guid)).toEqual([staged.droplet]);
  });
});

describe("the update block of an environment", () => {
  it("applies its defaults and refuses keys it does not know", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-ops-update-settings-"));
    try {
      const base = { target: { adapter: "fake" }, storage: { bucket: "b" }, app: { replicaPrefix: "database/", mediaPrefix: "media/", deliveryPrefix: "www/" }, backups: { prefix: "kestrel-backups/" } };
      const write = (env: Record<string, unknown>): Environment | undefined => {
        writeFileSync(join(root, "kestrel.environments.json"), JSON.stringify({ environments: { prod: env } }));
        return loadEnvironments(root).prod;
      };
      const plain = write(base);
      expect(plain?.update).toBeUndefined();
      expect(plain === undefined ? null : updateSettings(plain)).toEqual({ ...UPDATE_DEFAULTS, release: { dir: "." } });
      const partial = write({ ...base, update: { release: { dir: ".output" }, localBoot: { command: ["node", "server.mjs"], readyPath: "/ready", env: { DATA: "{database}" } } } });
      expect(partial?.update).toMatchObject({ release: { dir: ".output" }, sealTimeoutSeconds: 60, localBoot: { dir: ".", timeoutSeconds: 300 } });
      expect(() => write({ ...base, update: { rolling: true } })).toThrow(/update/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
