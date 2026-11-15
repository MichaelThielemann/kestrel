import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createHarness, PREFIXES, type Harness } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { markerKey } from "./replica.ts";

interface LaggingHarness {
  h: Harness;
  lagAfterStartMs: (ms: number) => void;
}

function laggingHarness(name: string, syncWindowSeconds: number, runtime?: string): LaggingHarness {
  const inner = memoryStore(new MemoryBucket(name));
  let lagMs: number | null = null;
  let startsBefore = Number.POSITIVE_INFINITY;
  let revealAt: number | null = null;
  const h = createHarness({
    ...(runtime === undefined ? {} : { runtime }),
    update: { syncWindowSeconds },
    store: {
      ...inner,
      get: async (key) => {
        if (lagMs !== null && key.endsWith("/applied.json") && h.app.starts > startsBefore) {
          revealAt ??= Date.now() + lagMs;
          if (Date.now() < revealAt) return null;
        }
        return inner.get(key);
      },
    },
  });
  return {
    h,
    lagAfterStartMs: (ms) => {
      lagMs = ms;
      startsBefore = h.app.starts;
      revealAt = null;
    },
  };
}

async function backupThenChange(h: Harness): Promise<string> {
  await h.app.start();
  await h.app.seed();
  const backup = await h.run(["backup", "create", "--freeze", "--json"]);
  expect(backup.code).toBe(0);
  h.app.run(`UPDATE pages SET "title" = 'Changed' WHERE "id" = 'home'`);
  await h.app.sync();
  return String(backup.json.id);
}

const promotedOf = (json: Record<string, unknown>): string => boundaryCast<{ generation: string }>(json.promoted, "json").generation;

describe("the wait of a restore for the app's acknowledgement", () => {
  it("lasts update.syncWindowSeconds after the app is ready, however few reads the poll options allow", async () => {
    const { h, lagAfterStartMs } = laggingHarness("late-acknowledgement", 4);
    try {
      const backupId = await backupThenChange(h);
      lagAfterStartMs(1500);
      const restored = await h.run(["restore", "--backup", backupId, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"], { poll: { delayMs: 5 } });
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "applied" });
      expect(restored.stderr).toBe("");
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it("ends with exit 0 and a warning naming the window, the key to look for and what to check when no acknowledgement appears", async () => {
    const { h } = laggingHarness("no-acknowledgement", 1);
    try {
      const backupId = await backupThenChange(h);
      h.app.failNextBoot = true;
      const startedAt = Date.now();
      const restored = await h.run(["restore", "--backup", backupId, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "unconfirmed" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000);
      const promoted = promotedOf(restored.json);
      expect(restored.stderr).toContain(`the app did not acknowledge ${promoted} within 1 s (update.syncWindowSeconds) after it became ready`);
      expect(restored.stderr).toContain(markerKey(PREFIXES.replica, promoted, "applied"));
      expect(restored.stderr).toContain("check the app's log for a failed boot run or replication.sync");
      expect(restored.stderr).not.toContain("does not report its replication runtime version");
      expect(restored.stderr).not.toContain("without restore reporting");
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it("names a target that does not report its runtime version, since a runtime before 6 never acknowledges", async () => {
    const { h } = laggingHarness("unknown-runtime", 1);
    try {
      const backupId = await backupThenChange(h);
      h.app.failNextBoot = true;
      h.app.describe = async () => ({ kind: "fake", packages: {} });
      const restored = await h.run(["restore", "--backup", backupId, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"], { generationWaitMs: 300 });
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "unconfirmed" });
      const promoted = promotedOf(restored.json);
      expect(restored.stderr).toContain(`the app did not acknowledge ${promoted} within 1 s`);
      expect(restored.stderr).toContain("the target does not report its replication runtime version, and a runtime before 6 writes no applied.json");
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it("is skipped for a runtime before 6, which writes no applied.json, and the output says so", async () => {
    const { h } = laggingHarness("runtime-before-6", 3600, "5.8.1");
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--answers", h.answers({ "unsealed-stop": "accept" }), "--json"]);
      expect(backup.code).toBe(0);
      h.app.run(`UPDATE pages SET "title" = 'Changed' WHERE "id" = 'home'`);
      await h.app.sync();
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--answers", h.answers({ confirm: "yes", "unsealed-stop": "accept", "access-changes": "accept" }), "--json"], { generationWaitMs: 300 });
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "unconfirmed" });
      const promoted = promotedOf(restored.json);
      expect(restored.stderr).toContain(`the app runs replication runtime 5.8.1, which writes no applied.json: it restores ${promoted} but does not render its output again by itself, so the restored delivery prefix stands for the rendered output`);
    } finally {
      await h.dispose();
    }
  }, 15_000);
});
