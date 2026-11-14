import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { keys, parseJson } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { backupRestoreRoundTrip } from "./scenario.fixture.ts";

describe("backup and restore against an in-memory store whose listings lag behind writes", () => {
  backupRestoreRoundTrip(async () => memoryStore(new MemoryBucket("lagging", { listLag: 1 })));
});

describe("backup and restore against an in-memory store", () => {
  backupRestoreRoundTrip(async () => memoryStore(new MemoryBucket("round-trip")));

  it("never overwrites a key of the backup location on any write path, also when listings lag", async () => {
    const bucket = new MemoryBucket("write-once", { listLag: 1 });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const first = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(first.code).toBe(0);
      await h.app.deleteMedia("m2");
      await h.app.export();
      await h.app.sync();
      expect((await h.run(["backup", "create", "--json"])).code).toBe(0);
      expect((await h.run(["backup", "verify", String(first.json.id)])).code).toBe(0);
      expect((await h.run(["restore", "--backup", String(first.json.id), "--answers", h.answers({ confirm: "yes", "access-changes": "accept" })])).code).toBe(0);
      expect((await h.run(["backup", "prune", "--dry-run"])).code).toBe(0);
      const overwrites = bucket.writes.filter((w) => w.key.startsWith(LOCATION) && w.op !== "delete" && w.existed);
      expect(overwrites).toEqual([]);
      expect(bucket.writes.filter((w) => w.key.startsWith(LOCATION)).length).toBeGreaterThan(20);
    } finally {
      await h.dispose();
    }
  });

  it("puts an edit made after the restore began into the pre-restore backup, and restoring that backup brings it back", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("safety")) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      const restore = await h.run(["restore", "--backup", String(backup.json.id), "--answers", h.answers({ "access-changes": "accept" }), "--json"], {
        prompt: async () => {
          h.app.run(`UPDATE pages SET "body" = 'edited during the restore' WHERE "id" = 'home'`);
          await h.app.sync();
          return "y";
        },
      });
      expect(restore.code).toBe(0);
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "Welcome" });
      const safety = String(restore.json.safetyBackup);
      const back = await h.run(["restore", "--backup", safety, "--yes", "--answers", h.answers({ "access-changes": "accept" })]);
      expect(back.code).toBe(0);
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "edited during the restore" });
    } finally {
      await h.dispose();
    }
  });

  it("ends every session and lists access changes; without the access-changes answer it refuses and starts the app again unchanged", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("access")) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      h.app.run(`UPDATE authn_users SET "active" = 0 WHERE "username" = 'editor'`);
      h.app.run(`UPDATE authn_users SET "roles" = '["viewer"]' WHERE "username" = 'admin'`);
      h.app.run(`INSERT INTO authn_users VALUES ('u3', 'intern', 'hash-3', '["editor"]', 1, 3)`);
      h.app.run(`DELETE FROM mfa_factors WHERE "userId" = 'u2'`);
      await h.app.sync();

      const refused = await h.run(["restore", "--backup", String(backup.json.id), "--yes"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("access-changes");
      expect(refused.stdout).toContain("users created after the backup, removed: intern");
      expect(refused.stdout).toContain("users deactivated after the backup, active again: editor");
      expect(refused.stdout).toContain("users whose roles changed, old roles back: admin");
      expect(refused.stdout).toContain("second factors reset after the backup, old factor back: admin");
      expect((await h.app.status()).state).toBe("started");
      expect(h.app.rows("authn_users")).toHaveLength(3);

      const accepted = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      expect(accepted.code).toBe(0);
      expect(accepted.json).toMatchObject({ loss: { access: { created: ["intern"], deactivated: ["editor"], rolesChanged: ["admin"], mfaReset: ["admin"], deleted: [] } } });
      expect(h.app.rows("authn_sessions")).toEqual([]);
      expect(h.app.rows("authn_users")).toHaveLength(2);
    } finally {
      await h.dispose();
    }
  });

  it("reports a failed check after the app started again as a warning, not as a stopped app, and releases the pre-restore backup", async () => {
    const inner = memoryStore(new MemoryBucket("after-start"));
    let failFrom = Number.POSITIVE_INFINITY;
    const h = createHarness({
      store: {
        ...inner,
        list: async (prefix) => {
          if (prefix === `${PREFIXES.replica}gen/` && h.app.starts >= failFrom) throw new Error("connection reset");
          return inner.list(prefix);
        },
      },
    });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      h.app.run(`UPDATE pages SET "body" = 'changed' WHERE "id" = 'home'`);
      await h.app.sync();
      failFrom = h.app.starts + 1;
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      failFrom = Number.POSITIVE_INFINITY;
      expect(restored.stderr).not.toContain("the app stays stopped");
      expect(restored.stderr).toContain("connection reset");
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "unconfirmed" });
      expect((await h.app.status()).state).toBe("started");
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "Welcome" });
      const list = await h.run(["backup", "list"]);
      expect(list.stdout).toContain(String(restored.json.safetyBackup));
      expect(list.stdout).not.toContain("pinned by");
    } finally {
      await h.dispose();
    }
  });

  it("names a truncated db.sqlite and a missing object when verification fails, with exit 1", async () => {
    const bucket = new MemoryBucket("verify");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const first = String((await h.run(["backup", "create", "--json"])).json.id);
      const dbKey = LOCATION + keys.db(first);
      const bytes = bucket.objects.get(dbKey)?.data ?? new Uint8Array();
      bucket.tamper(dbKey, bytes.slice(0, Math.floor(bytes.byteLength / 2)));
      const truncated = await h.run(["backup", "verify", first]);
      expect(truncated.code).toBe(1);
      expect(truncated.stderr).toContain("db.sqlite");

      const second = String((await h.run(["backup", "create", "--json"])).json.id);
      const object = LOCATION + keys.object(`${PREFIXES.media}m2/plan.pdf`, bucket.objects.get(`${PREFIXES.media}m2/plan.pdf`)?.etag ?? "");
      expect(bucket.objects.delete(object)).toBe(true);
      const missing = await h.run(["backup", "verify", second]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain(`${PREFIXES.media}m2/plan.pdf`);
      const records = [...bucket.objects.keys()].filter((k) => k.startsWith(`${LOCATION}backups/${second}/verify/`));
      expect(records.map((k) => parseJson(bucket.objects.get(k)?.data ?? new Uint8Array()))).toContainEqual(expect.objectContaining({ ok: false }));
    } finally {
      await h.dispose();
    }
  });

  it("reports a stop without teardown as unsealed with the time of the last segment, and --yes alone does not accept it", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("unsealed")) });
    try {
      await h.app.start();
      await h.app.seed();
      h.app.kill();
      const refused = await h.run(["backup", "create", "--freeze", "--yes"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/unsealed: generation \S+ has no seal/);
      expect(refused.stderr).toContain("unsealed-stop");
      const accepted = await h.run(["backup", "create", "--freeze", "--answers", h.answers({ "unsealed-stop": "accept" }), "--json"]);
      expect(accepted.code).toBe(0);
      const source: unknown = Reflect.get(Object(accepted.json.manifest), "source");
      expect(source).toMatchObject({ seal: "unsealed" });
      expect(Reflect.get(Object(source), "lastFrameAt")).toBeGreaterThan(0);
    } finally {
      await h.dispose();
    }
  });

  it("reports the seal of a runtime before the sealing major as unsupported and refuses --yes without the unsealed-stop answer", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("unsupported")), runtime: "5.8.1" });
    try {
      await h.app.start();
      await h.app.seed();
      const refused = await h.run(["backup", "create", "--freeze", "--yes"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("seal unsupported (runtime 5.8.1)");
      expect((await h.app.status()).state).toBe("started");
      const backup = await h.run(["backup", "create", "--freeze", "--answers", h.answers({ "unsealed-stop": "accept" }), "--json"]);
      expect(backup.code).toBe(0);
      expect(backup.json.manifest).toMatchObject({ source: { seal: "unsupported" } });
      h.app.run(`INSERT INTO pages VALUES ('later', 'Later', 'x')`);
      await h.app.sync();
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--answers", h.answers({ confirm: "yes", "unsealed-stop": "accept", "access-changes": "accept" }), "--json"]);
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "unconfirmed", loss: { tables: { pages: { added: 1 } } } });
      expect(h.app.rows("pages")).toHaveLength(3);
    } finally {
      await h.dispose();
    }
  });
});
