import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { keys, parseJson } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { buildDatabase, listGenerations } from "./replica.ts";
import { sha256File, vacuumInto } from "./sqlite.ts";

const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);

describe("a replica whose newest generation holds a segment without frames", () => {
  it("rebuilds byte for byte to its snapshot, and restore --to local, a backup and a restore of it hold that database", async () => {
    const bucket = new MemoryBucket("idle-replica");
    const store = memoryStore(bucket);
    const h = createHarness({ store });
    try {
      await h.app.start();
      await h.app.seed();
      await h.app.stop();
      await h.app.start();
      await h.app.sync();
      const rowsBefore = h.app.rows("pages");
      const newest = (await listGenerations(store, PREFIXES.replica)).at(-1);
      if (newest === undefined || newest.snapshot === null) throw new Error("the replica has no generation with a snapshot");
      expect(newest.segments.map((segment) => segment.size)).toEqual([32]);

      const snapshot = bucket.objects.get(newest.snapshot.key)?.data ?? new Uint8Array();
      const built = join(h.root, "built.db");
      await buildDatabase(store, PREFIXES.replica, newest, built);
      expect(Buffer.from(readFileSync(built)).equals(Buffer.from(snapshot))).toBe(true);
      const snapshotFile = join(h.root, "snapshot.db");
      writeFileSync(snapshotFile, snapshot);
      const expected = join(h.root, "expected.db");
      vacuumInto(snapshotFile, expected);

      const local = await h.run(["restore", "--to", "local", join(h.root, "copy"), "--latest", "--keep-sessions", "--json"]);
      expect(local.code, local.stderr).toBe(0);
      expect(Buffer.from(readFileSync(join(h.root, "copy", "kestrel.db"))).equals(readFileSync(expected))).toBe(true);

      const backup = await h.run(["backup", "create", "--json"]);
      expect(backup.code, backup.stderr).toBe(0);
      const id = String(backup.json.id);
      const manifest = parseJson(bucket.objects.get(LOCATION + keys.manifest(id))?.data ?? new Uint8Array());
      expect(field(field(manifest, "db"), "sha256")).toBe(sha256File(expected));

      const restored = await h.run(["restore", "--backup", id, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      expect(restored.code, restored.stderr).toBe(0);
      expect(h.app.rows("pages")).toEqual(rowsBefore);
    } finally {
      await h.dispose();
    }
  });
});
