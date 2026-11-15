import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { markerKey, type Applied, type Origin } from "@michaelthielemann/kestrel-replication-sqlite/impl";
import { createHarness, PREFIXES } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";

const readJson = <T>(bucket: MemoryBucket, key: string): T | null => {
  const data = bucket.objects.get(key)?.data;
  return data === undefined ? null : boundaryCast<T>(JSON.parse(new TextDecoder().decode(data)), "json");
};

describe("restore onto a runtime that understands origin.json", () => {
  it("is reported by replication.checkRestored, makes delivery.checkBuild render every output again and is acknowledged with applied.json naming the generation and nonce", async () => {
    const bucket = new MemoryBucket("placed");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      expect(h.app.lastBoot).toMatchObject({ databaseRestoredAt: null, checkBuild: { restored: false } });
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(backup.code).toBe(0);
      h.app.run(`UPDATE pages SET "title" = 'Changed' WHERE "id" = 'home'`);
      await h.app.sync();

      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      expect(restored.stderr).toBe("");
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "applied" });
      const promoted = String(boundaryCast<{ generation: string }>(restored.json.promoted, "json").generation);
      const origin = readJson<Origin>(bucket, markerKey(PREFIXES.replica, promoted, "origin"));
      expect(origin).toMatchObject({ kind: "restore", source: backup.json.id });

      const boot = h.app.lastBoot;
      expect(boot?.databaseRestoredAt).toEqual(expect.any(Number));
      expect(boot?.checkBuild.restored).toBe(true);
      expect(boot?.checkBuild.marked).toBe(3);
      expect(readJson<Applied>(bucket, markerKey(PREFIXES.replica, promoted, "applied"))).toEqual({ generation: promoted, nonce: origin?.nonce, restoredAt: boot?.databaseRestoredAt });
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "Welcome" });

      await h.app.stop();
      await h.app.start();
      expect(h.app.lastBoot).toMatchObject({ checkBuild: { restored: false, marked: 0 } });
    } finally {
      await h.dispose();
    }
  });

  it("renders once more on the next start when the first start wrote no acknowledgement, and reports the restore as unconfirmed", async () => {
    const bucket = new MemoryBucket("unacknowledged");
    const h = createHarness({ store: memoryStore(bucket), update: { syncWindowSeconds: 1 } });
    try {
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
      const promoted = String(boundaryCast<{ generation: string }>(restored.json.promoted, "json").generation);
      expect(h.app.lastBoot?.checkBuild.restored).toBe(true);
      expect(bucket.objects.has(markerKey(PREFIXES.replica, promoted, "applied"))).toBe(false);

      await h.app.stop();
      await h.app.start();
      expect(h.app.lastBoot?.checkBuild.restored).toBe(true);
      const nonce = readJson<Origin>(bucket, markerKey(PREFIXES.replica, promoted, "origin"))?.nonce;
      const acknowledged = [...bucket.objects.keys()].filter((key) => key.endsWith("/applied.json")).map((key) => readJson<Applied>(bucket, key));
      expect(acknowledged.length).toBeGreaterThan(0);
      expect(acknowledged.every((applied) => applied?.nonce === nonce)).toBe(true);

      await h.app.stop();
      await h.app.start();
      expect(h.app.lastBoot?.checkBuild.restored).toBe(false);
    } finally {
      await h.dispose();
    }
  });
});
