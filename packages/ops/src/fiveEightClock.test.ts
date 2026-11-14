import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryBucket, memoryStore, type MemoryBucketOptions } from "./memoryStore.ts";
import type { RunOptions } from "./run.ts";
import type { ObjectStore } from "./store.ts";
import { listGenerations } from "./replica.ts";
import { copyFixtureDatabase, FiveEightApp, FIXTURE_REPLICA, fixtureProject, loadFixtureBlobs, snapshotOnlyGeneration, type FixtureRun } from "./upgradeFixture.fixture.ts";

const STORE_AHEAD_MS = 3000;

describe("a restore onto a 5.8.1 app whose clock runs behind the store's", () => {
  let bucket: MemoryBucket;
  let app: FiveEightApp;
  let project: ReturnType<typeof fixtureProject>;
  let work: string;

  beforeEach(() => {
    bucket = new MemoryBucket("behind-5.8.1", { clock: () => Date.now() + STORE_AHEAD_MS });
    loadFixtureBlobs(bucket);
    app = new FiveEightApp(memoryStore(bucket));
    project = fixtureProject(bucket, () => app);
    work = mkdtempSync(join(tmpdir(), "kestrel-ops-behind-"));
  });
  afterEach(() => {
    project.dispose();
    app.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("starts the app only once its own clock passed the promoted generation, so the generation it names by that clock sorts last", async () => {
    const accept = { "unsealed-stop": "accept", "access-changes": "accept" };
    const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers(accept), "--json"]);
    expect(backup.code).toBe(0);
    const changed = join(work, "changed.db");
    copyFixtureDatabase(changed);
    const db = new DatabaseSync(changed);
    db.exec(`UPDATE pages SET "title__en" = 'Renamed after the backup' WHERE rowid = (SELECT min(rowid) FROM pages)`);
    db.close();
    await snapshotOnlyGeneration(memoryStore(bucket), Date.now() - 60_000, changed);

    const restored = await project.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers(accept), "--json"]);
    expect(restored.code).toBe(0);
    expect(restored.stderr).not.toContain("has not started its own generation yet");
    const promoted = String(Reflect.get(Object(restored.json.promoted), "generation"));
    expect(app.restoredFrom).toBe(promoted);
    const newest = (await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).at(-1)?.name ?? "";
    expect(newest > promoted).toBe(true);
  }, 30_000);
});

describe("a restore onto a 5.8.1 app whose clock runs behind the store's and this machine's", () => {
  let bucket: MemoryBucket;
  let app: FiveEightApp;
  let project: ReturnType<typeof fixtureProject>;
  let work: string;

  beforeEach(() => {
    bucket = new MemoryBucket("app-behind-5.8.1");
    loadFixtureBlobs(bucket);
    app = new FiveEightApp(memoryStore(bucket), () => Date.now() - 3000);
    project = fixtureProject(bucket, () => app);
    work = mkdtempSync(join(tmpdir(), "kestrel-ops-app-behind-"));
  });
  afterEach(() => {
    project.dispose();
    app.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("fails naming both generations and the app's clock when the generation the app starts sorts before the promoted one", async () => {
    const accept = { "unsealed-stop": "accept", "access-changes": "accept" };
    const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers(accept), "--json"]);
    expect(backup.code).toBe(0);
    const changed = join(work, "changed.db");
    copyFixtureDatabase(changed);
    const db = new DatabaseSync(changed);
    db.exec(`UPDATE pages SET "title__en" = 'Renamed after the backup' WHERE rowid = (SELECT min(rowid) FROM pages)`);
    db.close();
    await snapshotOnlyGeneration(memoryStore(bucket), Date.now() - 60_000, changed);
    const before = new Set((await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).map((g) => g.name));

    const restored = await project.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers(accept), "--json"]);
    expect(restored.code).toBe(1);
    const gens = (await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).map((g) => g.name);
    const promoted = app.restoredFrom ?? "";
    const own = gens.filter((name) => !before.has(name) && name !== promoted);
    expect(own).toHaveLength(1);
    expect(String(own[0]) < promoted).toBe(true);
    expect(gens.at(-1)).toBe(promoted);
    expect(restored.stderr).toContain(`the app started generation ${String(own[0])}, which sorts before the promoted generation ${promoted}`);
    expect(restored.stderr).toContain("the app's clock runs behind");
    expect(restored.stderr).toContain("stop the app, correct its clock and restore again");
    expect(restored.stderr).not.toContain("has not started its own generation yet");
    expect(restored.json).toMatchObject({ ok: false, element: "target" });
  }, 30_000);
});

describe("a restore onto a 5.8.1 app whose clock runs behind and whose own generation shows up late", () => {
  const accept = { "unsealed-stop": "accept", "access-changes": "accept" };
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const run of cleanup.reverse()) run();
    cleanup = [];
  });

  async function restoreAfterChange(listLag: number, firstSyncAfterMs: number | null, extra: Partial<RunOptions> = {}): Promise<{ restored: FixtureRun; bucket: MemoryBucket; app: FiveEightApp; before: Set<string> }> {
    const lag: MemoryBucketOptions = {};
    const bucket = new MemoryBucket(`late-5.8.1-${listLag}-${String(firstSyncAfterMs)}`, lag);
    loadFixtureBlobs(bucket);
    const app = new FiveEightApp(memoryStore(bucket), () => Date.now() - 3000, firstSyncAfterMs);
    const project = fixtureProject(bucket, () => app);
    const work = mkdtempSync(join(tmpdir(), "kestrel-ops-late-"));
    cleanup.push(() => project.dispose(), () => app.dispose(), () => rmSync(work, { recursive: true, force: true }));
    const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers(accept), "--json"]);
    expect(backup.code).toBe(0);
    const changed = join(work, "changed.db");
    copyFixtureDatabase(changed);
    const db = new DatabaseSync(changed);
    db.exec(`UPDATE pages SET "title__en" = 'Renamed after the backup' WHERE rowid = (SELECT min(rowid) FROM pages)`);
    db.close();
    await snapshotOnlyGeneration(memoryStore(bucket), Date.now() - 60_000, changed);
    const before = new Set((await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).map((g) => g.name));
    lag.listLag = listLag;
    const restored = await project.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers(accept), "--json"], extra);
    return { restored, bucket, app, before };
  }

  it.each([
    ["at its first sync after the start", 0, 500],
    ["two listings behind", 2, 0],
    ["three listings behind", 3, 0],
  ])("fails naming both generations when the app's generation shows up %s", async (_label, listLag, firstSyncAfterMs) => {
    const { restored, app } = await restoreAfterChange(listLag, firstSyncAfterMs);
    expect(restored.code).toBe(1);
    const promoted = app.restoredFrom ?? "";
    expect(restored.stderr).toMatch(new RegExp(`the app started generation \\S+, which sorts before the promoted generation ${promoted}`));
    expect(restored.stderr).not.toContain("unconfirmed");
    expect(restored.json).toMatchObject({ ok: false, element: "target" });
  }, 30_000);

  it("ends with exit 0 and says the order is unconfirmed when the app starts no generation within the wait", async () => {
    const { restored, bucket, before } = await restoreAfterChange(0, null, { generationWaitMs: 300 });
    expect(restored.code).toBe(0);
    const promoted = String(Reflect.get(Object(restored.json.promoted), "generation"));
    expect(restored.stderr).toContain(`the app started no generation of its own within 1 s: whether its first one sorts after the promoted generation ${promoted} is unconfirmed`);
    expect(restored.json).toMatchObject({ ok: true, ownGeneration: null });
    const gens = (await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).map((g) => g.name).filter((name) => !before.has(name));
    expect(gens).toEqual([promoted]);
  }, 30_000);
});

const RESTORE_ANSWERS = { "unsealed-stop": "accept", "access-changes": "accept" };

interface ChangedFixture {
  bucket: MemoryBucket;
  app: FiveEightApp;
  project: ReturnType<typeof fixtureProject>;
  restoreArgs: () => string[];
}

function changedAfterBackup(name: string, appClock: () => number, firstSyncAfterMs: number | null, cleanup: Array<() => void>): Promise<ChangedFixture> {
  return changedAfterBackupIn(new MemoryBucket(name), appClock, firstSyncAfterMs, cleanup);
}

async function changedAfterBackupIn(bucket: MemoryBucket, appClock: () => number, firstSyncAfterMs: number | null, cleanup: Array<() => void>): Promise<ChangedFixture> {
  loadFixtureBlobs(bucket);
  const app = new FiveEightApp(memoryStore(bucket), appClock, firstSyncAfterMs);
  const project = fixtureProject(bucket, () => app);
  const work = mkdtempSync(join(tmpdir(), "kestrel-ops-changed-"));
  cleanup.push(() => project.dispose(), () => app.dispose(), () => rmSync(work, { recursive: true, force: true }));
  const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers(RESTORE_ANSWERS), "--json"]);
  expect(backup.code).toBe(0);
  const changed = join(work, "changed.db");
  copyFixtureDatabase(changed);
  const db = new DatabaseSync(changed);
  db.exec(`UPDATE pages SET "title__en" = 'Renamed after the backup' WHERE rowid = (SELECT min(rowid) FROM pages)`);
  db.close();
  await snapshotOnlyGeneration(memoryStore(bucket), Date.now() - 60_000, changed);
  return { bucket, app, project, restoreArgs: () => ["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers(RESTORE_ANSWERS), "--json"] };
}

function failingOnce(inner: ObjectStore, op: "list" | "put", match: (key: string) => boolean): { store: ObjectStore; arm: () => void } {
  let armed = false;
  const fail = (key: string): void => {
    if (!armed || !match(key)) return;
    armed = false;
    throw new Error(`connection reset at ${key}`);
  };
  return {
    store: {
      ...inner,
      list: async (prefix) => {
        if (op === "list") fail(prefix);
        return inner.list(prefix);
      },
      put: async (key, data, options) => {
        if (op === "put") fail(key);
        return inner.put(key, data, options);
      },
    },
    arm: () => {
      armed = true;
    },
  };
}

describe("a restore onto a 5.8.1 app whose clock runs behind, while it waits for the app's own generation", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const run of cleanup.reverse()) run();
    cleanup = [];
  });

  function afterStart(app: FiveEightApp, ms: number, action: () => void): void {
    const start = app.start.bind(app);
    app.start = async () => {
      await start();
      const timer = setTimeout(action, ms);
      cleanup.push(() => clearTimeout(timer));
    };
  }

  it("ends with exit 1 and interrupted by SIGINT when the signal arrives during the wait, and says the order is unconfirmed", async () => {
    const { app, project, restoreArgs } = await changedAfterBackup("interrupted-wait-5.8.1", () => Date.now() - 10_000, 400, cleanup);
    const signals = new EventEmitter();
    afterStart(app, 150, () => signals.emit("SIGINT"));
    const restored = await project.run(restoreArgs(), { signals, generationWaitMs: 5000 });
    const promoted = app.restoredFrom ?? "";
    expect(restored.code).toBe(1);
    expect(restored.stderr).toContain("interrupted by SIGINT");
    expect(restored.stderr).toContain("the restore changed the store and started the app again");
    expect(restored.stderr).toContain(`whether its first one sorts after the promoted generation ${promoted} is unconfirmed`);
    expect(restored.json).toMatchObject({ ok: false });
  }, 30_000);

  it("ends with exit 0 and says the order is unconfirmed when a listing fails during the wait", async () => {
    const bucket = new MemoryBucket("failing-wait-5.8.1");
    const failing = failingOnce(memoryStore(bucket), "list", (prefix) => prefix.startsWith(FIXTURE_REPLICA));
    const { app, project, restoreArgs } = await changedAfterBackupIn(bucket, () => Date.now() - 10_000, 400, cleanup);
    afterStart(app, 150, failing.arm);
    const restored = await project.run(restoreArgs(), { stores: () => failing.store, generationWaitMs: 5000 });
    const promoted = app.restoredFrom ?? "";
    expect(restored.code).toBe(0);
    expect(restored.stderr).toContain("connection reset");
    expect(restored.stderr).toContain(`whether its first one sorts after the promoted generation ${promoted} is unconfirmed`);
    expect(restored.json).toMatchObject({ ok: true, ownGeneration: null });
  }, 30_000);
});
