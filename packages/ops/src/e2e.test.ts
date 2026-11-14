import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES, type Harness } from "./harness.fixture.ts";
import { keys, parseJson, unstamp } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { backupRestoreRoundTrip } from "./scenario.fixture.ts";

const SEGMENT_KEY = /^gen\/(\d{8}T\d{6}Z(?:-[0-9a-f]+)?)\/wal\/\d+-\d+-(\d{8}T\d{6}Z)\.wal$/;

async function shipSegmentInLaterSecond(h: Harness, bucket: MemoryBucket): Promise<number> {
  const newest = (): { generation: string; segments: number[] } => {
    const byGeneration = new Map<string, number[]>();
    for (const key of bucket.objects.keys()) {
      const m = SEGMENT_KEY.exec(key.slice(PREFIXES.replica.length));
      if (m && key.startsWith(PREFIXES.replica)) byGeneration.set(m[1] ?? "", [...(byGeneration.get(m[1] ?? "") ?? []), unstamp(m[2] ?? "")]);
    }
    const generation = [...byGeneration.keys()].sort().at(-1) ?? "";
    return { generation, segments: byGeneration.get(generation) ?? [] };
  };
  const before = newest();
  const startedAt = unstamp(before.generation.slice(0, 16));
  while (Date.now() < startedAt + 1000) await new Promise((done) => setTimeout(done, 50));
  h.app.run(`INSERT INTO pages VALUES ('shipped-later', 'Shipped later', 'x')`);
  await h.app.sync();
  const after = newest();
  expect(after.generation).toBe(before.generation);
  const last = Math.max(...after.segments);
  expect(last).toBeGreaterThan(startedAt);
  return last;
}

describe("backup and restore against an in-memory store whose listings lag behind writes", () => {
  backupRestoreRoundTrip(async () => memoryStore(new MemoryBucket("lagging", { listLag: 1 })));
});

describe("backup and restore against an in-memory store whose ETags are no digest of the bytes", () => {
  let writes = 0;
  backupRestoreRoundTrip(async () => memoryStore(new MemoryBucket("encrypted", { etag: () => `kms${String((writes += 1)).padStart(8, "0")}` })), { etagIsDigest: false });
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

  it("never overwrites a damaged object of the backup location: the next backup stops and names it", async () => {
    const bucket = new MemoryBucket("damaged-object");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const first = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(first.code).toBe(0);
      const object = [...bucket.objects.keys()].find((key) => key.startsWith(`${LOCATION}objects/${PREFIXES.media}m2/`));
      if (object === undefined) throw new Error("the backup holds no object of m2");
      bucket.tamper(object, new TextEncoder().encode("cut"));
      const writesBefore = bucket.writes.length;

      const second = await h.run(["backup", "create", "--json"]);
      expect(second.code).toBe(1);
      expect(second.stderr).toContain(object.slice(LOCATION.length));
      expect(second.stderr).toContain("damaged");
      expect(bucket.writes.slice(writesBefore).filter((w) => w.key.startsWith(LOCATION) && w.op !== "delete" && w.existed)).toEqual([]);
      expect(bucket.writes.slice(writesBefore).filter((w) => w.key === object)).toEqual([]);
      expect(bucket.objects.get(object)?.data.byteLength).toBe(3);
      expect((await h.run(["backup", "verify", String(first.json.id)])).code).toBe(1);
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
        get: async (key) => {
          if (key.endsWith("/applied.json") && h.app.starts >= failFrom) throw new Error("connection reset reading the acknowledgement");
          return inner.get(key);
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
      expect(restored.stderr).toContain("connection reset reading the acknowledgement");
      expect(restored.stderr).toContain("looking for a generation of the app failed: connection reset");
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "unconfirmed", ownGeneration: null });
      expect((await h.app.status()).state).toBe("started");
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "Welcome" });
      const list = await h.run(["backup", "list"]);
      expect(list.stdout).toContain(String(restored.json.safetyBackup));
      expect(list.stdout).not.toContain("pinned by");
    } finally {
      await h.dispose();
    }
  });

  it("refuses, before it stops the app, to restore a backup taken under another delivery prefix than the environment names", async () => {
    const bucket = new MemoryBucket("delivery-prefix");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(backup.code).toBe(0);
      h.editEnvironments((file) => {
        const app = file.environments.prod?.app;
        if (typeof app === "object" && app !== null) Reflect.set(app, "deliveryPrefix", "public/");
      });
      const starts = h.app.starts;
      const writes = bucket.writes.filter((w) => !w.key.startsWith(LOCATION)).length;
      const refused = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" })]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("www/");
      expect(refused.stderr).toContain("public/");
      expect(h.app.starts).toBe(starts);
      expect((await h.app.status()).state).toBe("started");
      expect(bucket.writes.filter((w) => !w.key.startsWith(LOCATION)).length).toBe(writes);
    } finally {
      await h.dispose();
    }
  });

  it("restores to a no-op without asking access-changes when only login sessions differ, and leaves the sessions", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("sessions-only")) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      h.app.run(`INSERT INTO authn_sessions VALUES ('s2', 'u2', 9999999999999, 2)`);
      await h.app.sync();
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--json"]);
      expect(restored.stderr).toBe("");
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ noop: true, sessionsDeleted: 0, safetyBackup: null });
      expect(h.app.rows("authn_sessions")).toHaveLength(2);
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

  it.each(["manifest.json", "blobs.jsonl", "site.jsonl"])("names a truncated %s when verification fails, records the failure and lists the backup as failed", async (file) => {
    const bucket = new MemoryBucket(`truncated-${file}`);
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const id = String((await h.run(["backup", "create", "--json"])).json.id);
      const key = `${LOCATION}backups/${id}/${file}`;
      const bytes = bucket.objects.get(key)?.data ?? new Uint8Array();
      expect(bytes.byteLength).toBeGreaterThan(0);
      bucket.tamper(key, bytes.slice(0, Math.floor(bytes.byteLength / 2)));
      const records = (): string[] => [...bucket.objects.keys()].filter((k) => k.startsWith(`${LOCATION}backups/${id}/verify/`));
      const before = records().length;

      const verified = await h.run(["backup", "verify", id, "--json"]);
      expect(verified.code).toBe(1);
      expect(verified.stderr).toContain(`${file}: `);
      expect(verified.json).toMatchObject({ ok: false, verification: { ok: false, problems: [expect.objectContaining({ element: file })] } });
      expect(records().length).toBe(before + 1);
      const listed = await h.run(["backup", "list", "--json"]);
      expect(listed.json.backups).toContainEqual(expect.objectContaining({ id, verified: false }));
      const pruned = await h.run(["backup", "prune", "--dry-run", "--json"]);
      if (file === "manifest.json") expect(pruned.code).toBe(0);
      else {
        expect(pruned.code).toBe(1);
        expect(pruned.stderr).toContain(`refusing to prune: ${file} of backup ${id} holds no valid JSON lines`);
      }
    } finally {
      await h.dispose();
    }
  });

  it.each(["blobs.jsonl", "site.jsonl"])("names a %s cut at a line boundary when verification fails, and a restore of that backup changes nothing", async (file) => {
    const bucket = new MemoryBucket(`cut-${file}`);
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const id = String((await h.run(["backup", "create", "--freeze", "--yes", "--json"])).json.id);
      const key = `${LOCATION}backups/${id}/${file}`;
      const lines = new TextDecoder().decode(bucket.objects.get(key)?.data ?? new Uint8Array()).split("\n").filter((line) => line !== "");
      expect(lines.length).toBeGreaterThan(1);
      bucket.tamper(key, new TextEncoder().encode(`${lines[0] ?? ""}\n`));
      const delivery = (): string[] => [...bucket.objects.keys()].filter((k) => k.startsWith(PREFIXES.delivery)).sort();
      const before = delivery();

      const verified = await h.run(["backup", "verify", id, "--json"]);
      expect(verified.code).toBe(1);
      expect(verified.stderr).toContain(`${file}: holds 1 entry, the manifest counts ${lines.length}`);
      expect(verified.json).toMatchObject({ ok: false, verification: { ok: false } });
      expect(Reflect.get(Object(verified.json.verification), "problems")).toContainEqual(expect.objectContaining({ element: file }));
      const listed = await h.run(["backup", "list", "--json"]);
      expect(listed.json.backups).toContainEqual(expect.objectContaining({ id, verified: false }));

      const restored = await h.run(["restore", "--backup", id, "--yes", "--answers", h.answers({ "access-changes": "accept" })]);
      expect(restored.code).toBe(1);
      expect(restored.stderr).toContain(`backup ${id} failed verification`);
      expect(restored.stderr).toContain(`${file}: holds 1 entry`);
      expect(delivery()).toEqual(before);
    } finally {
      await h.dispose();
    }
  });

  it("refuses a local copy with media of a backup whose blobs.jsonl was cut at a line boundary, naming blobs.jsonl, before it writes anything", async () => {
    const bucket = new MemoryBucket("cut-blobs-local");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const id = String((await h.run(["backup", "create", "--freeze", "--yes", "--json"])).json.id);
      const key = `${LOCATION}backups/${id}/blobs.jsonl`;
      const lines = new TextDecoder().decode(bucket.objects.get(key)?.data ?? new Uint8Array()).split("\n").filter((line) => line !== "");
      expect(lines.length).toBeGreaterThan(1);
      bucket.tamper(key, new TextEncoder().encode(`${lines[0] ?? ""}\n`));
      const out = join(h.root, "copy");

      const copied = await h.run(["restore", "--to", "local", out, "--backup", id, "--with-media", "--yes", "--json"]);
      expect(copied.code).toBe(1);
      expect(copied.stderr).toContain(`blobs.jsonl of backup ${id} holds 1 entry, the manifest counts ${lines.length}`);
      expect(copied.json).toMatchObject({ ok: false, element: "blobs.jsonl" });
      expect(existsSync(out)).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it.each(["blobs.jsonl", "site.jsonl"])("refuses to prune while the %s of a kept backup was cut at a line boundary, since the objects it refers to are then unknown", async (file) => {
    const bucket = new MemoryBucket(`cut-${file}-prune`);
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const id = String((await h.run(["backup", "create", "--freeze", "--yes", "--json"])).json.id);
      const key = `${LOCATION}backups/${id}/${file}`;
      const lines = new TextDecoder().decode(bucket.objects.get(key)?.data ?? new Uint8Array()).split("\n").filter((line) => line !== "");
      expect(lines.length).toBeGreaterThan(1);
      bucket.tamper(key, new TextEncoder().encode(`${lines[0] ?? ""}\n`));
      const objects = (): string[] => [...bucket.objects.keys()].filter((k) => k.startsWith(`${LOCATION}objects/`)).sort();
      const before = objects();
      const later = { clock: () => Date.now() + 3 * 24 * 3_600_000 };

      const dry = await h.run(["backup", "prune", "--dry-run", "--json"], later);
      expect(dry.code).toBe(1);
      expect(dry.stderr).toContain(`refusing to prune: ${file} of backup ${id} holds 1 entry, the manifest counts ${lines.length}, so the objects it refers to are unknown`);
      expect(dry.json).toMatchObject({ ok: false, element: file });
      const real = await h.run(["backup", "prune", "--yes"], later);
      expect(real.code).toBe(1);
      expect(objects()).toEqual(before);
    } finally {
      await h.dispose();
    }
  });

  it("names a site.jsonl whose keys differ from the manifest's when verification fails", async () => {
    const bucket = new MemoryBucket("renamed-site");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const id = String((await h.run(["backup", "create", "--json"])).json.id);
      const key = `${LOCATION}backups/${id}/site.jsonl`;
      const text = new TextDecoder().decode(bucket.objects.get(key)?.data ?? new Uint8Array());
      bucket.tamper(key, new TextEncoder().encode(text.replace(`${PREFIXES.delivery}about/`, `${PREFIXES.delivery}abaut/`)));
      const verified = await h.run(["backup", "verify", id]);
      expect(verified.code).toBe(1);
      expect(verified.stderr).toContain("site.jsonl: its keys do not hash to the manifest's pathsSha256");
    } finally {
      await h.dispose();
    }
  });

  it("reports a stop without teardown as unsealed with the time of the last segment, and --yes alone does not accept it", async () => {
    const bucket = new MemoryBucket("unsealed");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const lastSegmentAt = await shipSegmentInLaterSecond(h, bucket);
      h.app.kill();
      const refused = await h.run(["backup", "create", "--freeze", "--yes"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/unsealed: generation \S+ has no seal/);
      expect(refused.stderr).toContain(`last shipped segment ${new Date(lastSegmentAt).toISOString()},`);
      expect(refused.stderr).toContain("unsealed-stop");
      const accepted = await h.run(["backup", "create", "--freeze", "--answers", h.answers({ "unsealed-stop": "accept" }), "--json"]);
      expect(accepted.code).toBe(0);
      const source: unknown = Reflect.get(Object(accepted.json.manifest), "source");
      expect(source).toMatchObject({ seal: "unsealed", lastFrameAt: lastSegmentAt });
    } finally {
      await h.dispose();
    }
  });

  it("reports the seal of a runtime before the sealing major as unsupported and refuses --yes without the unsealed-stop answer", async () => {
    const bucket = new MemoryBucket("unsupported");
    const h = createHarness({ store: memoryStore(bucket), runtime: "5.8.1" });
    try {
      await h.app.start();
      await h.app.seed();
      const lastSegmentAt = await shipSegmentInLaterSecond(h, bucket);
      const refused = await h.run(["backup", "create", "--freeze", "--yes"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("seal unsupported (runtime 5.8.1)");
      expect(refused.stderr).toContain(`last shipped segment ${new Date(lastSegmentAt).toISOString()},`);
      expect((await h.app.status()).state).toBe("started");
      const backup = await h.run(["backup", "create", "--freeze", "--answers", h.answers({ "unsealed-stop": "accept" }), "--json"]);
      expect(backup.code).toBe(0);
      expect(backup.json.manifest).toMatchObject({ source: { seal: "unsupported" } });
      h.app.run(`INSERT INTO pages VALUES ('later', 'Later', 'x')`);
      await h.app.sync();
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--answers", h.answers({ confirm: "yes", "unsealed-stop": "accept", "access-changes": "accept" }), "--json"]);
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ acknowledgement: "unconfirmed", loss: { tables: { pages: { added: 1 } } } });
      expect(h.app.rows("pages")).toHaveLength(4);
    } finally {
      await h.dispose();
    }
  });
});
