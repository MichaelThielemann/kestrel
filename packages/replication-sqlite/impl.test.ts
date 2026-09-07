import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect } from "vitest";
import { BLOBSTORE, type Blob, type Blobstore, type BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { applyPendingRestore, createReplicationSqlite, restoreFromBlobs, restoreMarker, type Replication } from "./impl.ts";
import module from "./module.ts";

function fakeBlobs(): Blobstore & { blobs: Map<string, Blob>; failNext(code: "TRANSIENT"): void } {
  const blobs = new Map<string, Blob>();
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
    async put(k, b) {
      const e = injected();
      if (e) return err(e);
      blobs.set(k, { data: new Uint8Array(b.data), contentType: b.contentType });
      return ok();
    },
    async get(k) {
      const e = injected();
      if (e) return err(e);
      return ok(blobs.get(k) ?? null);
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
      return ok([...blobs].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.data.byteLength, contentType: b.contentType })));
    },
  };
}

function moduleDeps(blobs: Blobstore, root: string): Deps {
  return {
    get<T>(contract: Contract<T>): T {
      if (contract.name !== BLOBSTORE.name) throw new Error(`no provider for "${contract.name}"`);
      return blobs as T;
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root,
  };
}

const dirs: string[] = [];
const open: Replication[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(overrides: Partial<Parameters<typeof createReplicationSqlite>[0]> = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-"));
  dirs.push(dir);
  const file = join(dir, "live.db");
  const app = new DatabaseSync(file);
  app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  let t = Date.UTC(2026, 0, 1);
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const blobs = fakeBlobs();
  const config = { file, prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: true, ...overrides };
  const repl = createReplicationSqlite(config, blobs, clock.now);
  open.push(repl);
  const insert = (n: number) => { for (let i = 0; i < n; i++) app.prepare("INSERT INTO t (v) VALUES (?)").run(`row-${i}`); };
  const count = () => (app.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
  const restoreResult = (target: { generation?: string; at?: number }) => restoreFromBlobs(blobs, "replica/", target, join(dir, `restore-${Math.random().toString(36).slice(2)}.db`));
  const restoredCount = async (target: { generation?: string; at?: number }) => {
    const out = join(dir, `restore-${Math.random().toString(36).slice(2)}.db`);
    const result = expectOk(await restoreFromBlobs(blobs, "replica/", target, out));
    const db = new DatabaseSync(out);
    const n = (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
    const ok = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
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
    expect(first.generation).toMatch(/^\d{8}T\d{6}Z$/);
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

  it("a snapshot or restore before the first sync never ships segments into a null generation", async () => {
    const { repl, blobs, insert, clock, restoreResult } = setup();
    insert(3);
    expectErr(await repl.prepareRestore({}), "NOT_FOUND");
    const snap = expectOk(await repl.snapshot());
    expect(snap.generation).toMatch(/^\d{8}T\d{6}Z$/);
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
    expect(readFileSync(`${file}-wal`).byteLength).toBe(0);
    clock.advance(2_000);
    insert(10);
    expectOk(await repl.sync());
    const segments = [...blobs.blobs.keys()].filter((k) => k.includes("/wal/")).sort();
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(new Set(segments.map((k) => /wal\/(\d+)-/.exec(k)?.[1])).size).toBeGreaterThanOrEqual(2);
    expect(await restoredCount({})).toMatchObject({ n: 30, ok: "ok" });
  });

  it("new generations and retention", async () => {
    const { repl, insert, restoredCount, clock, blobs } = setup({ snapshotSeconds: 3600, retentionSeconds: 7200 });
    insert(1);
    expectOk(await repl.sync());
    const snapshot1 = expectOk(await repl.points())[0] as { generation: string; at: number };
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
    expect((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(104);
    db.close();
    expect(applyPendingRestore(file)).toBe(false);
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
