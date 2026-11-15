import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReplicationSqlite, restoreFromBlobs } from "@michaelthielemann/kestrel-replication-sqlite/impl";
import { isErr } from "@michaelthielemann/kestrel/result";
import { keys } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { PUBLISHED_RUNTIME_ENV, PublishedRuntimeApp, loadPublishedReplication } from "./publishedRuntime.fixture.ts";
import { blobstoreOf, listGenerations } from "./replica.ts";
import { allRows, copyFixtureDatabase, fixture, FIXTURE_LOCATION, FIXTURE_REPLICA, fixtureProject, loadFixtureBlobs } from "./upgradeFixture.fixture.ts";
import { CloudFoundryRun, killAfterPut, type KilledStore } from "./update/cloudFoundryRun.fixture.ts";
import { UPDATE_EXIT } from "./update/types.ts";

const runtimeDir = process.env[PUBLISHED_RUNTIME_ENV];

const withoutSessions = (rows: Record<string, unknown[]>): Record<string, unknown[]> => Object.fromEntries(Object.entries(rows).filter(([table]) => table !== "authn_sessions"));

describe.skipIf(runtimeDir === undefined)("the fixture on the published replication package of its release", () => {
  let bucket: MemoryBucket;
  let app: PublishedRuntimeApp;
  let project: ReturnType<typeof fixtureProject>;
  let work: string;
  let fixtureGeneration: string;

  beforeEach(async () => {
    bucket = new MemoryBucket("published-runtime");
    loadFixtureBlobs(bucket);
    fixtureGeneration = (await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).at(-1)?.name ?? "";
    app = new PublishedRuntimeApp(memoryStore(bucket), await loadPublishedReplication(runtimeDir ?? ""));
    project = fixtureProject(bucket, () => app);
    work = mkdtempSync(join(tmpdir(), "kestrel-ops-published-"));
    await app.start();
  });
  afterEach(() => {
    project.dispose();
    app.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("boots the fixture row for row, and a backup reports its seal as unsupported and refuses --yes without the unsealed-stop answer", async () => {
    expect(app.restoredFrom).toBe(fixtureGeneration);
    const original = join(work, "fixture.db");
    copyFixtureDatabase(original);
    expect(allRows(app.file)).toEqual(allRows(original));

    const refused = await project.run(["backup", "create", "--freeze", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`seal unsupported (runtime ${fixture.version})`);
    expect(refused.stderr).toContain("unsealed-stop");
    expect((await app.status()).state).toBe("started");
    expect([...bucket.objects.keys()].filter((key) => key.startsWith(FIXTURE_LOCATION) && key.endsWith("/manifest.json"))).toEqual([]);
  });

  it("starts from a promoted generation on its next boot and names its own generation after it", async () => {
    const accept = { "unsealed-stop": "accept", "access-changes": "accept" };
    const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers(accept), "--json"]);
    expect(backup.code).toBe(0);
    expect(backup.json.manifest).toMatchObject({ source: { seal: "unsupported" } });
    app.run(`UPDATE pages SET "title__en" = 'Renamed after the backup' WHERE rowid = (SELECT min(rowid) FROM pages)`);
    await app.sync();

    const restored = await project.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers(accept), "--json"]);
    expect(restored.code).toBe(0);
    expect(restored.json).toMatchObject({ noop: false, acknowledgement: "unconfirmed" });
    const promoted = String(Reflect.get(Object(restored.json.promoted), "generation"));
    expect(app.restoredFrom).toBe(promoted);
    const backedUp = join(work, "backup.db");
    writeFileSync(backedUp, bucket.objects.get(FIXTURE_LOCATION + keys.db(String(backup.json.id)))?.data ?? new Uint8Array());
    expect(withoutSessions(allRows(app.file))).toEqual(withoutSessions(allRows(backedUp)));

    const own = (await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).at(-1)?.name ?? "";
    expect(own > promoted).toBe(true);
    await app.stop();
    await app.start();
    expect(app.restoredFrom).toBe(own);
    expect(withoutSessions(allRows(app.file))).toEqual(withoutSessions(allRows(backedUp)));
  }, 30_000);
});

describe.skipIf(runtimeDir === undefined)("an update hop from the fixture with the old release on the published replication package", () => {
  let instances: PublishedRuntimeApp[];
  let run: CloudFoundryRun;

  beforeEach(async () => {
    instances = [];
    const published = await loadPublishedReplication(runtimeDir ?? "");
    const store = memoryStore(new MemoryBucket("published-update"));
    run = await CloudFoundryRun.create(store, { version: fixture.version, runtime: fixture.version, renders: false }, {
      fixture: true,
      instance: (release) => {
        if (release.version !== fixture.version) return null;
        const instance = new PublishedRuntimeApp(store, published);
        instances.push(instance);
        return instance;
      },
    });
  });
  afterEach(async () => {
    await run.dispose();
    for (const instance of instances) instance.dispose();
  });

  const expectCutoverStateOnThePublishedRelease = async (runId: string): Promise<void> => {
    const ended = await run.run(runId);
    expect(ended.state).toBe("rolled-back");
    expect(run.current().version).toBe(fixture.version);
    expect(run.instance).not.toBeNull();
    expect(run.liveRows()).toEqual(await run.backupRows(ended.cutoverBackup ?? ""));
    expect(run.starts.filter((start) => start.version === fixture.version).map((start) => start.origin)).toEqual([null, "restore"]);
    expect(run.violations).toEqual([]);
    expect(ended.records.find((r) => r.step === "rollback-verify" && r.state === "done")?.data).toMatchObject({ provenance: "marker" });
  };

  it("rolls a failed verification back: the published release starts only on the cutover state promoted again, which its first snapshot proves", async () => {
    run.addRelease({ version: "6.0.0", modules: true, ready: "not-ready" });
    expect((await run.update(["prepare"])).code).toBe(UPDATE_EXIT.done);
    const deployed = await run.update(["deploy"]);
    expect(deployed.code, deployed.stderr).toBe(UPDATE_EXIT.rolledBack);
    await expectCutoverStateOnThePublishedRelease(String(deployed.json.runId));
  }, 300_000);

  it("aborts a deploy killed after the promotion by rolling back before the published release starts again", async () => {
    run.addRelease({ version: "6.0.0", modules: true });
    expect((await run.update(["prepare"])).code).toBe(UPDATE_EXIT.done);
    const seen: { killed?: KilledStore } = {};
    const deployed = await run.update(["deploy"], { store: (store) => (seen.killed = killAfterPut(store, (key) => key.endsWith("-promote-done.json"))).store });
    expect(seen.killed?.killed).toBe(true);
    expect(run.instance).toBeNull();
    const aborted = await run.update(["abort", "--break-lock"], { answers: { "break-lock": "accept" } });
    expect(aborted.code, aborted.stderr).toBe(UPDATE_EXIT.done);
    await expectCutoverStateOnThePublishedRelease(String(deployed.json.runId));
  }, 300_000);
});

describe.skipIf(runtimeDir === undefined)("replicas between this version and the published replication package of the fixture's release", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "kestrel-ops-published-replica-"));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const config = (file: string) => ({ file, prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 86400, retentionSeconds: 172800, restoreOnStart: true });

  function liveDatabase(): { file: string; db: DatabaseSync; write: (rounds: number) => void } {
    const file = join(work, "live.db");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    const update = db.prepare("UPDATE t SET v = ? WHERE id = ?");
    let next = 0;
    const write = (rounds: number) => {
      for (let round = 0; round < rounds; round++) {
        db.exec("BEGIN");
        for (let i = 0; i < 40; i++) insert.run(`${next++}-`.padEnd(3000, "r"));
        for (let i = 1; i <= 20; i++) update.run(`${next}-${i}-`.padEnd(2000, "u"), 1 + ((next * 7 + i) % next));
        db.exec("COMMIT");
      }
    };
    return { file, db, write };
  }

  async function restoredRows(restore: (out: string) => Promise<unknown>): Promise<{ rows: Record<string, unknown[]>; bytes: Uint8Array }> {
    const out = join(work, `restored-${Math.random().toString(36).slice(2)}.db`);
    await restore(out);
    return { rows: allRows(out), bytes: new Uint8Array(readFileSync(out)) };
  }

  it("restores with the published package, byte for byte as this version does, the snapshot and segments this version wrote, under a generation named by its time alone", async () => {
    const published = await loadPublishedReplication(runtimeDir ?? "");
    const bucket = new MemoryBucket("published-replica");
    const blobs = blobstoreOf(memoryStore(bucket));
    const { file, db, write } = liveDatabase();
    const replication = createReplicationSqlite(config(file), blobs);
    try {
      write(30);
      const first = await replication.sync();
      if (isErr(first)) throw new Error(first.error.message);
      write(20);
      const snapshot = await replication.snapshot();
      if (isErr(snapshot)) throw new Error(snapshot.error.message);
      write(10);
      const last = await replication.sync();
      if (isErr(last)) throw new Error(last.error.message);
    } finally {
      replication.close();
    }
    const current = await restoredRows(async (out) => {
      const restored = await restoreFromBlobs(blobs, "replica/", {}, out);
      if (isErr(restored)) throw new Error(restored.error.message);
    });
    const newest = (await listGenerations(memoryStore(bucket), "replica/")).at(-1)?.name ?? "";
    for (const [key, object] of [...bucket.objects]) if (key.startsWith(`replica/gen/${newest}/`)) bucket.objects.set(key.replace(`/gen/${newest}/`, `/gen/${newest.slice(0, 16)}/`), object);
    const old = await restoredRows(async (out) => {
      const restored = await published.restoreFromBlobs(blobs, "replica/", { generation: newest.slice(0, 16) }, out);
      if (isErr(restored)) throw new Error(restored.error.message);
    });
    db.close();
    expect(newest.length).toBeGreaterThan(16);
    expect(old.rows).toEqual(allRows(file));
    expect(Buffer.from(old.bytes).equals(Buffer.from(current.bytes))).toBe(true);
  }, 60_000);

  it("restores with the published package, byte for byte to the snapshot, a generation of this version whose only segment holds no frames", async () => {
    const published = await loadPublishedReplication(runtimeDir ?? "");
    const bucket = new MemoryBucket("published-replica");
    const blobs = blobstoreOf(memoryStore(bucket));
    const { file, db, write } = liveDatabase();
    const replication = createReplicationSqlite(config(file), blobs);
    try {
      write(30);
      for (let run = 0; run < 2; run++) {
        const synced = await replication.sync();
        if (isErr(synced)) throw new Error(synced.error.message);
      }
    } finally {
      replication.close();
    }
    const generation = (await listGenerations(memoryStore(bucket), "replica/")).at(-1);
    if (generation === undefined || generation.snapshot === null) throw new Error("the replica holds no snapshot");
    expect(generation.segments.map((segment) => segment.size)).toEqual([32]);
    const snapshot = bucket.objects.get(generation.snapshot.key)?.data ?? new Uint8Array();
    for (const [key, object] of [...bucket.objects]) if (key.startsWith(`replica/gen/${generation.name}/`)) bucket.objects.set(key.replace(`/gen/${generation.name}/`, `/gen/${generation.name.slice(0, 16)}/`), object);
    const old = await restoredRows(async (out) => {
      const restored = await published.restoreFromBlobs(blobs, "replica/", { generation: generation.name.slice(0, 16) }, out);
      if (isErr(restored)) throw new Error(restored.error.message);
    });
    db.close();
    expect(old.rows).toEqual(allRows(file));
    expect(Buffer.from(old.bytes).equals(Buffer.from(snapshot))).toBe(true);
  }, 60_000);

  it("restores with this version, byte for byte as the published package does, what the published package wrote", async () => {
    const published = await loadPublishedReplication(runtimeDir ?? "");
    const bucket = new MemoryBucket("published-replica");
    const blobs = blobstoreOf(memoryStore(bucket));
    const { file, db, write } = liveDatabase();
    const replication = published.createReplicationSqlite(config(file), blobs);
    try {
      write(30);
      const first = await replication.sync();
      if (isErr(first)) throw new Error(first.error.message);
      write(20);
      const last = await replication.sync();
      if (isErr(last)) throw new Error(last.error.message);
    } finally {
      replication.close();
    }
    const current = await restoredRows(async (out) => {
      const restored = await restoreFromBlobs(blobs, "replica/", {}, out);
      if (isErr(restored)) throw new Error(restored.error.message);
    });
    const old = await restoredRows(async (out) => {
      const restored = await published.restoreFromBlobs(blobs, "replica/", {}, out);
      if (isErr(restored)) throw new Error(restored.error.message);
    });
    db.close();
    expect(current.rows).toEqual(allRows(file));
    expect(Buffer.from(current.bytes).equals(Buffer.from(old.bytes))).toBe(true);
  }, 60_000);
});
