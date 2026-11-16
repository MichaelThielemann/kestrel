import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { keys, parseJson } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { listGenerations } from "./replica.ts";

type Damage = (bucket: MemoryBucket) => Promise<void>;

const damages: Array<[string, Damage]> = [
  [
    "has no generation",
    async (bucket) => {
      for (const key of [...bucket.objects.keys()]) if (key.startsWith(PREFIXES.replica)) bucket.objects.delete(key);
    },
  ],
  [
    "has a newest generation that cannot be rebuilt",
    async (bucket) => {
      const newest = (await listGenerations(memoryStore(bucket), PREFIXES.replica)).at(-1);
      if (!newest?.snapshot) throw new Error("no generation to damage");
      bucket.tamper(newest.snapshot.key, new TextEncoder().encode("not a database"));
    },
  ],
  [
    "has a sealed newest generation that lacks a segment the seal counts",
    async (bucket) => {
      const newest = (await listGenerations(memoryStore(bucket), PREFIXES.replica)).at(-1);
      const last = newest?.segments.at(-1);
      if (!newest?.files["sealed.json"] || !last) throw new Error("a sealed generation with segments expected");
      bucket.objects.delete(last.key);
    },
  ],
];

describe("restore over a replica that cannot be read", { timeout: 30_000 }, () => {
  for (const [label, damage] of damages) {
    it(`restores a verified backup when the current replica ${label}, only after the unreadable-current answer`, async () => {
      const bucket = new MemoryBucket(`unreadable-${label}`);
      const h = createHarness({ store: memoryStore(bucket) });
      try {
        await h.app.start();
        await h.app.seed();
        const backup = await h.run(["backup", "create", "--freeze", "--json"]);
        expect(backup.code).toBe(0);
        const id = String(backup.json.id);
        h.app.run(`INSERT INTO pages VALUES ('late', 'Late', 'after the backup')`);
        await h.app.stop();
        await damage(bucket);

        const refused = await h.run(["restore", "--backup", id, "--yes", "--answers", h.answers({ "access-changes": "accept" })]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("the current database cannot be read");
        expect(refused.stderr).toContain('"unreadable-current" needs an answer');

        const restored = await h.run(["restore", "--backup", id, "--yes", "--answers", h.answers({ "access-changes": "accept", "unreadable-current": "accept" }), "--json"]);
        expect(restored.stderr).toContain("the current database cannot be read");
        expect(restored.code).toBe(0);
        expect(restored.json).toMatchObject({ loss: null, acknowledgement: "applied" });
        expect(h.app.rows("pages")).toHaveLength(3);

        const safety = String(restored.json.safetyBackup);
        const manifest = parseJson(bucket.objects.get(LOCATION + keys.manifest(safety))?.data ?? new Uint8Array());
        expect(manifest).toMatchObject({ db: null, source: { seal: "unreadable", generation: null } });
        expect(bucket.objects.has(LOCATION + keys.db(safety))).toBe(false);
        expect((await h.run(["backup", "verify", safety])).code).toBe(0);
        const back = await h.run(["restore", "--backup", safety, "--yes"]);
        expect(back.code).toBe(1);
        expect(back.stderr).toContain(`backup ${safety} holds no database`);
        expect((await h.app.status()).state).toBe("started");
      } finally {
        await h.dispose();
      }
    });
  }
});
