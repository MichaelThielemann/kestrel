import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createHarness, PREFIXES, type Harness } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { listGenerations } from "./replica.ts";

async function restoredWithoutAcknowledgement(h: Harness): Promise<{ backupId: string; promoted: string }> {
  await h.app.start();
  await h.app.seed();
  const backup = await h.run(["backup", "create", "--freeze", "--json"]);
  expect(backup.code).toBe(0);
  h.app.run(`UPDATE pages SET "title" = 'Changed' WHERE "id" = 'home'`);
  await h.app.sync();
  h.app.failNextBoot = true;
  const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
  expect(restored.code).toBe(0);
  expect(restored.json).toMatchObject({ acknowledgement: "unconfirmed" });
  return { backupId: String(backup.json.id), promoted: boundaryCast<{ generation: string }>(restored.json.promoted, "json").generation };
}

async function expectUnsealedQuestion(h: Harness, backupId: string): Promise<void> {
  const frozen = await h.run(["backup", "create", "--freeze", "--yes", "--json"]);
  expect(frozen.code).toBe(1);
  expect(frozen.stderr).toContain('"unsealed-stop" needs an answer');
  const restore = await h.run(["restore", "--backup", backupId, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
  expect(restore.code).toBe(1);
  expect(restore.stderr).toContain('"unsealed-stop" needs an answer');
  const accepted = await h.run(["backup", "create", "--freeze", "--yes", "--answers", h.answers({ "unsealed-stop": "accept" }), "--json"]);
  expect(accepted.code).toBe(0);
  expect(accepted.json).toMatchObject({ manifest: { source: { seal: "unsealed" } } });
}

describe("a kill without teardown after a restore", () => {
  it("is reported as unsealed when the app had started its own generation, which carries a copied origin.json", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("kill-own-generation")) });
    try {
      const { backupId, promoted } = await restoredWithoutAcknowledgement(h);
      const own = (await listGenerations(h.store, PREFIXES.replica)).at(-1);
      expect(own?.name.startsWith(`${promoted.slice(0, 8)}`)).toBe(true);
      expect(own?.name).not.toBe(promoted);
      expect(own?.files["origin.json"]).toBeDefined();
      expect(own?.files["applied.json"]).toBeUndefined();
      expect(own?.segments).toEqual([]);
      h.app.run(`INSERT INTO pages VALUES ('news', 'News', 'Not shipped')`);
      h.app.kill();
      await expectUnsealedQuestion(h, backupId);
    } finally {
      await h.dispose();
    }
  });

  it("is reported as unsealed when the app was killed before it started a generation of its own", async () => {
    const bucket = new MemoryBucket("kill-before-first-sync");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      const { backupId, promoted } = await restoredWithoutAcknowledgement(h);
      h.app.kill();
      for (const generation of await listGenerations(h.store, PREFIXES.replica)) {
        if (generation.name <= promoted) continue;
        for (const key of [...bucket.objects.keys()]) if (key.startsWith(`${PREFIXES.replica}gen/${generation.name}/`)) bucket.objects.delete(key);
      }
      const newest = (await listGenerations(h.store, PREFIXES.replica)).at(-1);
      expect(newest?.name).toBe(promoted);
      expect(newest?.files["origin.json"]).toBeDefined();
      expect(newest?.segments).toEqual([]);
      await expectUnsealedQuestion(h, backupId);
    } finally {
      await h.dispose();
    }
  });
});
