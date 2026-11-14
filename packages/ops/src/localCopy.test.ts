import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { listGenerations } from "./replica.ts";
import type { ObjectStore } from "./store.ts";

function failingOrigin(inner: ObjectStore): { store: ObjectStore; arm: () => void } {
  let armed = false;
  return {
    store: {
      ...inner,
      put: async (key, data, options) => {
        if (armed && key.startsWith(PREFIXES.replica) && key.endsWith("/origin.json")) {
          armed = false;
          throw new Error(`connection reset writing ${key}`);
        }
        return inner.put(key, data, options);
      },
    },
    arm: () => {
      armed = true;
    },
  };
}

describe("restore --to local --latest over an unfinished placement", () => {
  it("copies the generation before it, which holds the current state, and names the unfinished placement", async () => {
    const failing = failingOrigin(memoryStore(new MemoryBucket("latest-half-placement")));
    const h = createHarness({ store: failing.store });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(backup.code).toBe(0);
      h.app.run(`INSERT INTO pages VALUES ('news', 'News', 'Written after the backup')`);
      await h.app.export();
      await h.app.sync();
      failing.arm();
      expect((await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" })])).code).toBe(1);
      const half = (await listGenerations(h.store, PREFIXES.replica)).at(-1)?.name ?? "";
      expect(half).toMatch(/^\d{8}T\d{6}Z$/);

      const out = join(h.root, "latest");
      const copied = await h.run(["restore", "--to", "local", out, "--latest", "--yes", "--json"]);
      expect(copied.code).toBe(0);
      expect(copied.stderr).toContain(`generation ${half} is an unfinished placement`);
      const db = new DatabaseSync(join(out, "kestrel.db"));
      try {
        expect(db.prepare(`SELECT "id" FROM pages ORDER BY "id"`).all().map((row) => row.id)).toEqual(["about", "contact", "home", "news"]);
      } finally {
        db.close();
      }
    } finally {
      await h.dispose();
    }
  });
});

describe("restore --to local --with-media into a directory that does not exist yet", () => {
  it("creates no directory before the confirm answer", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("local-no-mkdir")) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"]);
      expect(backup.code).toBe(0);
      const out = join(h.root, "fresh", "copy");
      const unanswered = await h.run(["restore", "--to", "local", out, "--backup", String(backup.json.id), "--with-media"]);
      expect(unanswered.code).toBe(1);
      expect(unanswered.stderr).toContain('"confirm" needs an answer');
      expect(existsSync(join(h.root, "fresh"))).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it("removes the directories it created when the copy fails", async () => {
    const bucket = new MemoryBucket("local-cleanup");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"]);
      expect(backup.code).toBe(0);
      const object = [...bucket.objects.keys()].find((key) => key.startsWith(`${LOCATION}objects/media/m3/`));
      if (object === undefined) throw new Error("the backup's copy of an original expected");
      bucket.objects.delete(object);
      const out = join(h.root, "fresh", "copy");
      const failed = await h.run(["restore", "--to", "local", out, "--backup", String(backup.json.id), "--with-media", "--yes"]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("is missing");
      expect(existsSync(join(h.root, "fresh"))).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it("leaves an existing directory as it found it when the copy fails", async () => {
    const bucket = new MemoryBucket("local-cleanup-existing");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"]);
      expect(backup.code).toBe(0);
      const object = [...bucket.objects.keys()].find((key) => key.startsWith(`${LOCATION}objects/media/m3/`));
      if (object === undefined) throw new Error("the backup's copy of an original expected");
      bucket.objects.delete(object);
      const out = join(h.root, "existing");
      mkdirSync(join(out, "blobs", "kept"), { recursive: true });
      const failed = await h.run(["restore", "--to", "local", out, "--backup", String(backup.json.id), "--with-media", "--yes"]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("is missing");
      expect(readdirSync(out, { recursive: true }).map(String).sort()).toEqual(["blobs", join("blobs", "kept")]);
    } finally {
      await h.dispose();
    }
  });
});
