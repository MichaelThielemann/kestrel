import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect } from "vitest";
import { BLOBSTORE, type Blobstore, type BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { applyPendingRestore, createReplicationSqlite, listSealedReplica, restoreFromBlobs, restoreMarker, type Replication } from "./impl.ts";
import module from "./module.ts";

function fakeBlobs(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }>; failNext(code: "TRANSIENT"): void } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  let pending: "TRANSIENT" | null = null;
  const injected = (): BlobstoreError | null => {
    if (pending === null) return null;
    pending = null;
    return failure("TRANSIENT", "fakeBlobs: injected TRANSIENT");
  };
  return {
    blobs,
    failNext(code) {
      pending = code;
    },
    async put(k, data, options) {
      const e = injected();
      if (e) return err(e);
      blobs.set(k, { data: new Uint8Array(data), contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(k) {
      const e = injected();
      if (e) return err(e);
      return ok(blobs.get(k)?.data ?? null);
    },
    async remove(k) {
      const e = injected();
      if (e) return err(e);
      blobs.delete(k);
      return ok();
    },
    async move(from, to) {
      const e = injected();
      if (e) return err(e);
      const b = blobs.get(from);
      if (!b) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(p) {
      const e = injected();
      if (e) return err(e);
      return ok([...blobs].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.data.byteLength })));
    },
  };
}

function moduleDeps(blobs: Blobstore, root: string): Deps {
  return {
    get<T>(contract: Contract<T>): T {
      if (contract.name !== BLOBSTORE.name) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(blobs, "host");
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root,
    eventTriggers: [],
  };
}

const dirs: string[] = [];
const open: Replication[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Clock = { now: () => number; advance: (ms: number) => void };

function manualClock(start = Date.UTC(2026, 0, 1)): Clock {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function setup(overrides: Partial<Parameters<typeof createReplicationSqlite>[0]> = {}, shared: { blobs?: ReturnType<typeof fakeBlobs>; clock?: Clock; logger?: Logger } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-"));
  dirs.push(dir);
  const file = join(dir, "live.db");
  const app = new DatabaseSync(file);
  app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const clock = shared.clock ?? manualClock();
  const blobs = shared.blobs ?? fakeBlobs();
  const config = { file, prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: true, ...overrides };
  const repl = createReplicationSqlite(config, blobs, clock.now, shared.logger ? { logger: shared.logger } : {});
  open.push(repl);
  const insert = (n: number) => { for (let i = 0; i < n; i++) app.prepare("INSERT INTO t (v) VALUES (?)").run(`row-${i}`); };
  const count = () => boundaryCast<{ n: number }>(app.prepare("SELECT count(*) AS n FROM t").get(), "host").n;
  const restoreResult = (target: { generation?: string; at?: number }) => restoreFromBlobs(blobs, "replica/", target, join(dir, `restore-${Math.random().toString(36).slice(2)}.db`));
  const restoredCount = async (target: { generation?: string; at?: number }) => {
    const out = join(dir, `restore-${Math.random().toString(36).slice(2)}.db`);
    const result = expectOk(await restoreFromBlobs(blobs, "replica/", target, out));
    const db = new DatabaseSync(out);
    const n = boundaryCast<{ n: number }>(db.prepare("SELECT count(*) AS n FROM t").get(), "host").n;
    const ok = boundaryCast<{ integrity_check: string }>(db.prepare("PRAGMA integrity_check").get(), "host").integrity_check;
    db.close();
    return { n, ok, ...result };
  };
  return { dir, file, app, blobs, repl, insert, count, restoredCount, restoreResult, clock, config };
}

describe("replication/sqlite", () => {
  it("first sync takes a snapshot, later syncs ship only committed WAL frames", async () => {
    const { repl, blobs, insert, count, restoredCount, clock } = setup();
    insert(5);
    const first = expectOk(await repl.sync());
    expect(first.generation).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{44}$/);
    expect([...blobs.blobs.keys()].some((k) => k.endsWith("/snapshot.db"))).toBe(true);
    expect((await restoredCount({})).n).toBe(5);

    clock.advance(30_000);
    insert(7);
    const second = expectOk(await repl.sync());
    expect(second.frames).toBeGreaterThan(0);
    expect(count()).toBe(12);
    expect(await restoredCount({})).toMatchObject({ n: 12, ok: "ok" });

    clock.advance(30_000);
    expect(expectOk(await repl.sync()).frames).toBe(0);
  });

  it("names every generation with a random part, so a snapshot key cannot be derived from the time it was taken", async () => {
    const { repl, blobs, insert } = setup();
    insert(1);
    const first = expectOk(await repl.snapshot()).generation;
    const second = expectOk(await repl.snapshot()).generation;
    expect(first.slice(0, 16)).toBe(second.slice(0, 16));
    expect(first).not.toBe(second);
    expect([...blobs.blobs.keys()].sort()).toEqual([`replica/gen/${first}/snapshot.db`, `replica/gen/${second}/snapshot.db`].sort());
    const points = expectOk(await repl.points());
    expect(points).toHaveLength(2);
    expect(points.every((point) => Number.isFinite(point.at))).toBe(true);
  });

  it("orders generations taken within the same second by when they were taken, so a restore picks the newest", async () => {
    const { repl, insert, restoreResult } = setup();
    insert(1);
    const generations: string[] = [];
    for (let i = 0; i < 20; i++) generations.push(expectOk(await repl.snapshot()).generation);
    expect(expectOk(await repl.points()).map((point) => point.generation)).toEqual(generations);
    expect(expectOk(await restoreResult({})).generation).toBe(generations.at(-1));
  });

  it("still lists and restores a generation named by its time alone", async () => {
    const { repl, blobs, insert, restoredCount } = setup();
    insert(4);
    const current = expectOk(await repl.snapshot()).generation;
    const snapshot = blobs.blobs.get(`replica/gen/${current}/snapshot.db`);
    if (!snapshot) throw new Error("snapshot missing");
    blobs.blobs.delete(`replica/gen/${current}/snapshot.db`);
    blobs.blobs.set("replica/gen/20260101T000000Z/snapshot.db", snapshot);
    const points = expectOk(await repl.points());
    expect(points).toEqual([{ generation: "20260101T000000Z", at: Date.parse("2026-01-01T00:00:00Z"), kind: "snapshot", key: "replica/gen/20260101T000000Z/snapshot.db" }]);
    expect(await restoredCount({ generation: "20260101T000000Z" })).toMatchObject({ n: 4, ok: "ok" });
  });

  it("restores a snapshot of a fragmented database with later frames layered on top", async () => {
    const { app, repl, count, restoredCount, clock } = setup();
    const wide = app.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 500; i++) wide.run("x".repeat(300) + i);
    app.exec("DELETE FROM t WHERE id % 3 <> 0; PRAGMA wal_checkpoint(TRUNCATE)");
    expectOk(await repl.sync());
    const snapshotOnly = await restoredCount({});
    expect(snapshotOnly).toMatchObject({ n: count(), ok: "ok" });

    clock.advance(30_000);
    for (let i = 0; i < 40; i++) wide.run("z".repeat(300) + i);
    expect(expectOk(await repl.sync()).frames).toBeGreaterThan(0);
    expect(await restoredCount({})).toMatchObject({ n: count(), ok: "ok" });
  });

  it("a restore whose rebuilt image fails quick_check is refused and leaves no file behind", async () => {
    const { repl, blobs, insert, restoreResult, dir } = setup();
    insert(3);
    const gen = expectOk(await repl.sync()).generation;
    const key = `replica/gen/${gen}/snapshot.db`;
    const snapshot = blobs.blobs.get(key);
    if (!snapshot) throw new Error("snapshot missing");
    snapshot.data.fill(0xff, 100);
    const error = expectErr(await restoreResult({}), "TRANSIENT");
    expect(error.message).toContain(gen);
    expect(error.message).toContain("quick_check");
    expect(readdirSync(dir).filter((f) => f.startsWith("restore-"))).toEqual([]);
  });

  it("a snapshot or restore before the first sync never ships segments into a null generation", async () => {
    const { repl, blobs, insert, clock, restoreResult } = setup();
    insert(3);
    expectErr(await repl.prepareRestore({}), "NOT_FOUND");
    const snap = expectOk(await repl.snapshot());
    expect(snap.generation).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{44}$/);
    expect([...blobs.blobs.keys()].filter((k) => k.includes("/gen/null/"))).toEqual([]);
    expect([...blobs.blobs.keys()]).toEqual([`replica/gen/${snap.generation}/snapshot.db`]);
    clock.advance(30_000);
    insert(2);
    expectOk(await repl.sync());
    expect([...blobs.blobs.keys()].filter((k) => k.includes("/wal/")).every((k) => k.startsWith(`replica/gen/${snap.generation}/wal/`))).toBe(true);
    expect((await restoreResult({})).ok).toBe(true);

    blobs.blobs.set("replica/gen/null/wal/000001-000000-20260101T000000Z.wal", { data: new Uint8Array([1]), contentType: "application/octet-stream" });
    expect(expectOk(await repl.points()).some((p) => p.generation === "null")).toBe(false);
  });

  it("restores to a point in time between segments", async () => {
    const { repl, insert, restoredCount, restoreResult, clock } = setup();
    insert(1);
    expectOk(await repl.sync());
    const t1 = clock.now();
    clock.advance(60_000);
    insert(2);
    expectOk(await repl.sync());
    const t2 = clock.now();
    clock.advance(60_000);
    insert(3);
    expectOk(await repl.sync());
    expect((await restoredCount({ at: t1 })).n).toBe(1);
    expect((await restoredCount({ at: t2 })).n).toBe(3);
    expect((await restoredCount({ at: t2 + 1 })).n).toBe(3);
    expect((await restoredCount({})).n).toBe(6);
    const error = expectErr(await restoreResult({ at: t1 - 1 }), "NOT_FOUND");
    expect(error.message).toMatch(/no snapshot/);
  });

  it("survives checkpoints: frames after a WAL reset land in a new lineage", async () => {
    const { repl, insert, restoredCount, clock, file, blobs } = setup({ checkpointSeconds: 1 });
    insert(10);
    expectOk(await repl.sync());
    clock.advance(2_000);
    insert(10);
    const r = expectOk(await repl.sync());
    expect(r.checkpointed).toBe(true);
    const walAfterCheckpoint = readFileSync(`${file}-wal`).byteLength;
    clock.advance(2_000);
    insert(10);
    expectOk(await repl.sync());
    expect(readFileSync(`${file}-wal`).byteLength).toBeLessThanOrEqual(walAfterCheckpoint);
    const segments = [...blobs.blobs.keys()].filter((k) => k.includes("/wal/")).sort();
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(new Set(segments.map((k) => /wal\/(\d+)-/.exec(k)?.[1])).size).toBeGreaterThanOrEqual(2);
    expect(await restoredCount({})).toMatchObject({ n: 30, ok: "ok" });
  });

  it("new generations and retention", async () => {
    const { repl, insert, restoredCount, clock, blobs } = setup({ snapshotSeconds: 3600, retentionSeconds: 7200 });
    insert(1);
    expectOk(await repl.sync());
    const snapshot1 = expectOk(await repl.points())[0];
    if (!snapshot1) throw new Error("expected a point after the first sync");
    clock.advance(3600_000 + 1);
    insert(1);
    expectOk(await repl.sync());
    const gens = [...new Set(expectOk(await repl.points()).map((p) => p.generation))];
    expect(gens).toHaveLength(2);
    expect((await restoredCount({ generation: snapshot1.generation, at: snapshot1.at })).n).toBe(1);
    expect((await restoredCount({ generation: snapshot1.generation })).n).toBe(2);
    expect((await restoredCount({})).n).toBe(2);
    clock.advance(4 * 3600_000);
    insert(1);
    const r = expectOk(await repl.sync());
    expect(r.pruned).toBeGreaterThan(0);
    expect([...blobs.blobs.keys()].some((k) => k.includes(`/${snapshot1.generation}/`))).toBe(false);
    expect((await restoredCount({})).n).toBe(3);
  });

  it("shipping pending frames via sync before close persists them, as the module's teardown does", async () => {
    const { repl, insert, restoredCount, app } = setup();
    insert(3);
    expectOk(await repl.sync());
    insert(2);
    expectOk(await repl.sync());
    repl.close();
    open.splice(0);
    app.close();
    expect((await restoredCount({})).n).toBe(5);
  });

  it("prepareRestore writes the marker file that applyPendingRestore swaps in", async () => {
    const { repl, insert, file, app } = setup();
    insert(4);
    expectOk(await repl.sync());
    insert(100);
    const prepared = expectOk(await repl.prepareRestore({}));
    expect(prepared.restartRequired).toBe(true);
    expect(existsSync(restoreMarker(file))).toBe(true);
    expect((await repl.status()).pendingRestore).toBe(restoreMarker(file));
    repl.close();
    open.splice(0);
    app.close();
    expect(applyPendingRestore(file)).toBe(true);
    const db = new DatabaseSync(file);
    expect(boundaryCast<{ n: number }>(db.prepare("SELECT count(*) AS n FROM t").get(), "host").n).toBe(104);
    db.close();
    expect(applyPendingRestore(file)).toBe(false);
  });

  it("health() reports a prepared restore informationally: the instance still serves", async () => {
    const { repl, insert } = setup();
    insert(4);
    expectOk(await repl.sync());
    expect(repl.health()).toEqual({ ok: true });
    expectOk(await repl.prepareRestore({}));
    expect(repl.health()).toEqual({ ok: true, note: expect.stringContaining("restart") as unknown });
  });

  it("two boots keep their own logger; teardown on the first instance never touches a later boot's logger", async () => {
    const dir1 = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-mod-"));
    const dir2 = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-mod-"));
    dirs.push(dir1, dir2);
    const file1 = join(dir1, "live.db");
    const file2 = join(dir2, "live.db");
    const app1 = new DatabaseSync(file1);
    app1.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    app1.prepare("INSERT INTO t (v) VALUES ('x')").run();
    const app2 = new DatabaseSync(file2);
    app2.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const errors1: string[] = [];
    const errors2: string[] = [];
    const logger1 = { step() {}, info() {}, error: (m: string) => errors1.push(m) };
    const logger2 = { step() {}, info() {}, error: (m: string) => errors2.push(m) };
    const failingBlobs: Blobstore = {
      async put() { return err(failure("TRANSIENT", "no blobstore")); },
      async get() { return ok(null); },
      async remove() { return ok(); },
      async move() { return ok(); },
      async list() { return ok([]); },
    };
    const cfgBase = { prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: false };
    const first = await module.setup(module.configSchema.parse({ ...cfgBase, file: file1 }), { ...moduleDeps(failingBlobs, dir1), logger: logger1 });
    const second = await module.setup(module.configSchema.parse({ ...cfgBase, file: file2 }), { ...moduleDeps(fakeBlobs(), dir2), logger: logger2 });
    await module.teardown!(first);
    await module.teardown!(second);
    app1.close();
    app2.close();
    expect(errors1).toHaveLength(1);
    expect(errors2).toHaveLength(0);
  });

  it("a transient blobstore failure surfaces as a retryable 503 from replication.sync", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-mod-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const blobs = fakeBlobs();
    const cfg = { prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: false, file };
    const instance = await module.setup(module.configSchema.parse(cfg), moduleDeps(blobs, dir));
    const sync = module.steps!(instance).sync;
    blobs.failNext("TRANSIENT");
    const error = expectErr(await sync(createContext({ trigger: { kind: "http", name: "t" }, payload: {} })), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    await module.teardown!(instance);
  });

  it("prepareRestore step rejects an unparsable at parameter as VALIDATION", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-mod-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const blobs = fakeBlobs();
    const cfg = { prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: false, file };
    const instance = await module.setup(module.configSchema.parse(cfg), moduleDeps(blobs, dir));
    const prepareRestore = module.steps!(instance).prepareRestore;
    const error = expectErr(await prepareRestore(createContext({ trigger: { kind: "http", name: "t" }, payload: { at: "not-a-date" } })), "VALIDATION");
    expect(error.message).toMatch(/invalid "at" value/);
    await module.teardown!(instance);
  });

  it("prepareRestore step answers NOT_FOUND when no snapshot exists yet", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-mod-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const blobs = fakeBlobs();
    const cfg = { prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: false, file };
    const instance = await module.setup(module.configSchema.parse(cfg), moduleDeps(blobs, dir));
    const prepareRestore = module.steps!(instance).prepareRestore;
    const error = expectErr(await prepareRestore(createContext({ trigger: { kind: "http", name: "t" }, payload: {} })), "NOT_FOUND");
    expect(error.message).toMatch(/no snapshot/);
    await module.teardown!(instance);
  });
});

describe("replication/sqlite generation order, seal and other writers", () => {
  const stampOf = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const orderKey = (ms: number): string => ms.toString(16).padStart(12, "0");

  function image(rows: number): Uint8Array {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-image-"));
    dirs.push(dir);
    const file = join(dir, "image.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < rows; i++) db.prepare("INSERT INTO t (v) VALUES (?)").run(`placed-${i}`);
    db.close();
    return new Uint8Array(readFileSync(file));
  }

  function place(blobs: ReturnType<typeof fakeBlobs>, generation: string, data: Uint8Array, origin: boolean): void {
    blobs.blobs.set(`replica/gen/${generation}/snapshot.db`, { data, contentType: "application/vnd.sqlite3" });
    if (origin) blobs.blobs.set(`replica/gen/${generation}/origin.json`, { data: new TextEncoder().encode(JSON.stringify({ kind: "restore", source: "backup-1", nonce: "nonce-1" })), contentType: "application/json" });
  }

  function readJson(blobs: ReturnType<typeof fakeBlobs>, key: string): unknown {
    const blob = blobs.blobs.get(key);
    if (!blob) throw new Error(`${key} is missing`);
    return JSON.parse(new TextDecoder().decode(blob.data));
  }

  function warningLogger(): { warnings: Array<{ message: string; data?: Record<string, unknown> }>; logger: Logger } {
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    return { warnings, logger: { ...silentLogger, warn: (message, data) => warnings.push(data === undefined ? { message } : { message, data }) } };
  }

  it("names its first generation after a generation placed with a stamp ten minutes ahead, so the next restore picks this process's data", async () => {
    const { repl, blobs, insert, clock, restoredCount } = setup();
    const placed = stampOf(clock.now() + 10 * 60_000);
    place(blobs, placed, image(1), true);
    insert(3);
    const own = expectOk(await repl.sync()).generation;
    expect(own > placed).toBe(true);
    expect(own.slice(0, 16)).toBe(placed);
    expect(await restoredCount({})).toMatchObject({ generation: own, n: 3, ok: "ok" });
  });

  it("names a later snapshot after a newer generation listed meanwhile", async () => {
    const { repl, blobs, insert, clock } = setup();
    insert(1);
    expectOk(await repl.sync());
    const placed = stampOf(clock.now() + 10 * 60_000);
    place(blobs, placed, image(1), true);
    clock.advance(1_000);
    expect(expectOk(await repl.snapshot()).generation > placed).toBe(true);
  });

  it("names its generation after a listed one of the same second whose order key is ahead of this process's clock", async () => {
    const { repl, blobs, insert, clock } = setup();
    const ahead = `${stampOf(clock.now())}-${orderKey(clock.now() + 500)}${"f".repeat(32)}`;
    place(blobs, ahead, image(1), false);
    clock.advance(100);
    insert(1);
    const own = expectOk(await repl.sync()).generation;
    expect(own > ahead).toBe(true);
    expect(own.slice(0, 16)).toBe(ahead.slice(0, 16));
  });

  it("seal ships the frames committed since the last sync, then writes sealed.json, and neither checkpoints, snapshots nor prunes although all three are due", async () => {
    const { repl, blobs, insert, clock, restoredCount } = setup({ checkpointSeconds: 1, snapshotSeconds: 60, retentionSeconds: 60 });
    insert(2);
    const generation = expectOk(await repl.sync()).generation;
    const checkpointedAt = (await repl.status()).lastCheckpointAt;
    place(blobs, "20251201T000000Z", image(1), false);
    place(blobs, "20251202T000000Z", image(1), false);
    insert(3);
    clock.advance(5 * 60_000);
    const puts: string[] = [];
    const put = blobs.put.bind(blobs);
    blobs.put = async (key, data, options) => {
      puts.push(key);
      return put(key, data, options);
    };

    const sealed = expectOk(await repl.seal());

    const segments = [...blobs.blobs.keys()].filter((key) => key.startsWith(`replica/gen/${generation}/wal/`));
    const seal = { lineage: expect.any(Number) as unknown, lastFrame: (await repl.status()).shippedFrames, segments: segments.length, at: clock.now() };
    expect(readJson(blobs, `replica/gen/${generation}/sealed.json`)).toEqual(seal);
    expect(sealed).toEqual({ generation, ...seal });
    expect(puts.length).toBeGreaterThan(1);
    expect(puts.at(-1)).toBe(`replica/gen/${generation}/sealed.json`);
    expect(puts.slice(0, -1).every((key) => key.startsWith(`replica/gen/${generation}/wal/`))).toBe(true);
    expect([...blobs.blobs.keys()].filter((key) => key.endsWith("/snapshot.db"))).toHaveLength(3);
    expect((await repl.status()).lastCheckpointAt).toBe(checkpointedAt);
    expect(await restoredCount({ generation })).toMatchObject({ n: 5, ok: "ok" });
  });

  it("prunes the marker files of an expired generation with its snapshot and segments, and a generation of marker files alone", async () => {
    const { repl, blobs, insert, clock } = setup({ snapshotSeconds: 3600, retentionSeconds: 7200 });
    const placed = stampOf(clock.now() - 1000);
    place(blobs, placed, image(1), true);
    blobs.blobs.set(`replica/gen/${placed}/applied.json`, { data: new TextEncoder().encode("{}"), contentType: "application/json" });
    blobs.blobs.set(`replica/gen/${placed}/sealed.json`, { data: new TextEncoder().encode("{}"), contentType: "application/json" });
    const markersOnly = stampOf(clock.now() - 60_000);
    blobs.blobs.set(`replica/gen/${markersOnly}/sealed.json`, { data: new TextEncoder().encode("{}"), contentType: "application/json" });
    insert(1);
    expectOk(await repl.sync());
    clock.advance(3 * 3600_000);
    insert(1);
    const second = expectOk(await repl.sync()).generation;
    clock.advance(3 * 3600_000);
    insert(1);
    const third = expectOk(await repl.sync());
    expect(third.pruned).toBeGreaterThan(0);
    expect([...new Set([...blobs.blobs.keys()].map((key) => key.split("/")[2]))].sort()).toEqual([second, third.generation].sort());
  });

  it("seal before any sync takes the first snapshot when frames were committed, and seals it", async () => {
    const { repl, blobs, insert, restoredCount } = setup();
    insert(2);
    const sealed = expectOk(await repl.seal());
    if (sealed === null) throw new Error("expected a seal");
    expect([...blobs.blobs.keys()].sort()).toEqual([`replica/gen/${sealed.generation}/sealed.json`, `replica/gen/${sealed.generation}/snapshot.db`]);
    expect(sealed).toMatchObject({ segments: 0 });
    expect(await restoredCount({})).toMatchObject({ generation: sealed.generation, n: 2, ok: "ok" });
  });

  it("seal before any sync writes nothing when no frame was committed since the file was opened", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const app = new DatabaseSync(file);
    app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); PRAGMA wal_checkpoint(TRUNCATE)");
    app.close();
    const blobs = fakeBlobs();
    const repl = createReplicationSqlite({ file, prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: true }, blobs, manualClock().now);
    open.push(repl);
    expect(expectOk(await repl.seal())).toBeNull();
    expect(blobs.blobs.size).toBe(0);
  });

  it("notes another process writing into the same replica in health, staying ok, and logs one warning", async () => {
    const blobs = fakeBlobs();
    const clock = manualClock();
    const firstLog = warningLogger();
    const first = setup({}, { blobs, clock, logger: firstLog.logger });
    first.insert(1);
    expectOk(await first.repl.sync());
    clock.advance(5_000);
    const secondLog = warningLogger();
    const second = setup({}, { blobs, clock, logger: secondLog.logger });
    second.insert(1);
    expectOk(await second.repl.sync());
    expect(second.repl.health()).toEqual({ ok: true });

    clock.advance(5_000);
    first.insert(1);
    expectOk(await first.repl.sync());
    expect(first.repl.health()).toEqual({ ok: true, note: expect.stringContaining("another process writes to this replica") as unknown });
    expect(firstLog.warnings).toEqual([{ message: expect.stringContaining("another process writes to this replica") as unknown, data: expect.objectContaining({ key: expect.stringContaining("/snapshot.db") as unknown }) as unknown }]);

    clock.advance(5_000);
    second.insert(1);
    expectOk(await second.repl.sync());
    expect(second.repl.health()).toEqual({ ok: true, note: expect.stringContaining("another process writes to this replica") as unknown });
    expect(secondLog.warnings).toEqual([{ message: expect.stringContaining("another process writes to this replica") as unknown, data: expect.objectContaining({ key: expect.stringContaining("/wal/") as unknown }) as unknown }]);

    clock.advance(5_000);
    first.insert(1);
    expectOk(await first.repl.sync());
    expect(firstLog.warnings).toHaveLength(1);
  });

  it("counts neither a generation placed with origin.json while it runs, nor one listed when it first looked, nor a segment stamped before it started", async () => {
    const blobs = fakeBlobs();
    const clock = manualClock();
    const earlier = stampOf(clock.now() - 60_000);
    place(blobs, earlier, image(1), false);
    const log = warningLogger();
    const { repl, insert } = setup({}, { blobs, clock, logger: log.logger });
    insert(1);
    expectOk(await repl.sync());
    blobs.blobs.set(`replica/gen/${earlier}/wal/000001-000000-${stampOf(clock.now() - 30_000)}.wal`, { data: new Uint8Array([1]), contentType: "application/octet-stream" });
    clock.advance(60_000);
    place(blobs, stampOf(clock.now() + 10 * 60_000), image(1), true);
    insert(1);
    expectOk(await repl.sync());
    clock.advance(60_000);
    insert(1);
    expectOk(await repl.sync());
    expect(repl.health()).toEqual({ ok: true });
    expect(log.warnings).toEqual([]);
  });
});

describe("replication/sqlite listing against the seal", () => {
  function sealedReplica(): { blobs: ReturnType<typeof fakeBlobs>; generation: string } {
    const blobs = fakeBlobs();
    const generation = "20260101T000000Z";
    blobs.blobs.set(`replica/gen/${generation}/snapshot.db`, { data: new Uint8Array([1]), contentType: "application/vnd.sqlite3" });
    for (let seq = 0; seq < 3; seq++) blobs.blobs.set(`replica/gen/${generation}/wal/000001-${String(seq).padStart(6, "0")}-20260101T000001Z.wal`, { data: new Uint8Array([1]), contentType: "application/octet-stream" });
    blobs.blobs.set(`replica/gen/${generation}/sealed.json`, { data: new TextEncoder().encode(JSON.stringify({ lineage: 1, lastFrame: 9, segments: 3, at: 0 })), contentType: "application/json" });
    return { blobs, generation };
  }

  it("lists again until the newest generation shows every segment its seal names", async () => {
    const { blobs, generation } = sealedReplica();
    const last = `replica/gen/${generation}/wal/000001-000002-20260101T000001Z.wal`;
    const lagging = blobs.blobs.get(last);
    blobs.blobs.delete(last);
    const waits: number[] = [];
    const listed = expectOk(await listSealedReplica(blobs, "replica/", { attempts: 5, delayMs: 100, sleep: async (ms) => {
      waits.push(ms);
      if (lagging && waits.length === 2) blobs.blobs.set(last, lagging);
    } }));
    expect(waits).toEqual([100, 100]);
    expect(listed.missing).toBe(0);
    expect(listed.listing.points.filter((p) => p.kind === "wal")).toHaveLength(3);
  });

  it("answers how many sealed segments the last listing still lacks once the attempts are used up", async () => {
    const { blobs, generation } = sealedReplica();
    blobs.blobs.delete(`replica/gen/${generation}/wal/000001-000001-20260101T000001Z.wal`);
    const waits: number[] = [];
    const listed = expectOk(await listSealedReplica(blobs, "replica/", { attempts: 3, delayMs: 50, sleep: async (ms) => { waits.push(ms); } }));
    expect(waits).toEqual([50, 50]);
    expect(listed).toMatchObject({ generation, segments: 3, missing: 1 });
  });

  it("lists once when the newest generation has no seal", async () => {
    const { blobs, generation } = sealedReplica();
    blobs.blobs.delete(`replica/gen/${generation}/sealed.json`);
    blobs.blobs.delete(`replica/gen/${generation}/wal/000001-000001-20260101T000001Z.wal`);
    const waits: number[] = [];
    const listed = expectOk(await listSealedReplica(blobs, "replica/", { sleep: async (ms) => { waits.push(ms); } }));
    expect(waits).toEqual([]);
    expect(listed.missing).toBe(0);
  });
});
