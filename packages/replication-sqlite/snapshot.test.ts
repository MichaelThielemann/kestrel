import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type * as FsPromisesModule from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { createReplicationSqlite, restoreFromBlobs, type Replication } from "./impl.ts";
import { referenceRestore, referenceSnapshot } from "./reference.fixture.ts";

const io = vi.hoisted(() => ({ beforeRead: null as null | ((path: string) => Promise<void> | void) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        value: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          await io.beforeRead?.(path);
          return read(buffer, offset, length, position);
        },
      });
      return handle;
    },
  };
});

function memoryBlobs(): Blobstore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(key, data) {
      blobs.set(key, data);
      return ok();
    },
    async get(key) {
      const blob = blobs.get(key);
      return ok(blob ? new Uint8Array(blob) : null);
    },
    async remove(key) {
      blobs.delete(key);
      return ok();
    },
    async move(from, to) {
      const blob = blobs.get(from);
      if (blob) blobs.set(to, blob);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...blobs].filter(([key]) => key.startsWith(prefix)).map(([key, blob]) => ({ key, size: blob.byteLength })));
    },
  };
}

const dirs: string[] = [];
const open: Replication[] = [];
const apps: DatabaseSync[] = [];
const workers: Worker[] = [];

beforeEach(() => {
  io.beforeRead = null;
});

afterEach(async () => {
  io.beforeRead = null;
  for (const w of workers.splice(0)) await w.terminate();
  for (const r of open.splice(0)) r.close();
  for (const release of hung.splice(0)) release();
  await sleep(20);
  for (const a of apps.splice(0)) a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hung: Array<() => void> = [];
const hang = <T>(value: T) => new Promise<T>((resolve) => hung.push(() => resolve(value)));

type Overrides = { checkpointBytes?: number; checkpointSeconds?: number; snapshotSeconds?: number; retentionSeconds?: number };

function live(overrides: { autoVacuum?: boolean } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-snap-"));
  dirs.push(dir);
  const file = join(dir, "live.db");
  const app = new DatabaseSync(file);
  apps.push(app);
  if (overrides.autoVacuum) app.exec("PRAGMA auto_vacuum = INCREMENTAL");
  app.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE counter (k TEXT PRIMARY KEY, n INTEGER); INSERT INTO counter VALUES ('main', 0), ('other', 0)");
  let t = Date.UTC(2026, 0, 1);
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const stmt = app.prepare("INSERT INTO t (v) VALUES (?)");
  const insert = (n: number, width = 100) => {
    app.exec("BEGIN");
    for (let i = 0; i < n; i++) stmt.run(`${i}-`.padEnd(width, "x"));
    app.exec("COMMIT");
  };
  const bump = app.prepare("UPDATE counter SET n = n + 1 WHERE k = 'main'");
  const counted = (width = 600) => {
    app.exec("BEGIN");
    stmt.run("main-".padEnd(width, "c"));
    bump.run();
    app.exec("COMMIT");
  };
  const blobs = memoryBlobs();
  const start = (config: Overrides = {}, options: { checkIntervalMs?: number } = {}) => {
    const repl = createReplicationSqlite({ file, prefix: "replica/", checkpointBytes: 1024 * 1024 * 1024, checkpointSeconds: 100_000, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: true, ...config }, blobs, clock.now, { checkIntervalMs: 3_600_000, ...options });
    open.push(repl);
    return repl;
  };
  const walSize = () => {
    try {
      return statSync(`${file}-wal`).size;
    } catch {
      return 0;
    }
  };
  return { dir, file, app, blobs, clock, insert, counted, start, walSize };
}

function fingerprint(db: DatabaseSync): { n: number; s: number | null; main: number; other: number; mainRows: number; otherRows: number } {
  const rows = boundaryCast<{ n: number; s: number | null }>(db.prepare("SELECT count(*) AS n, sum(length(v) * id) AS s FROM t").get(), "host");
  const counters = boundaryCast<Array<{ k: string; n: number }>>(db.prepare("SELECT k, n FROM counter").all(), "host");
  const by = (k: string) => counters.find((c) => c.k === k)?.n ?? -1;
  const tagged = (tag: string) => boundaryCast<{ n: number }>(db.prepare("SELECT count(*) AS n FROM t WHERE v LIKE ?").get(`${tag}-%`), "host").n;
  return { ...rows, main: by("main"), other: by("other"), mainRows: tagged("main"), otherRows: tagged("other") };
}

async function restored(blobs: Blobstore, dir: string, target: { generation?: string; at?: number } = {}) {
  const out = join(dir, `restore-${Math.random().toString(36).slice(2)}.db`);
  const result = expectOk(await restoreFromBlobs(blobs, "replica/", target, out));
  const db = new DatabaseSync(out);
  try {
    return { ...result, ...fingerprint(db), check: boundaryCast<{ integrity_check: string }>(db.prepare("PRAGMA integrity_check").get(), "host").integrity_check, bytes: new Uint8Array(readFileSync(out)) };
  } finally {
    db.close();
  }
}

function snapshotOf(blobs: ReturnType<typeof memoryBlobs>, generation: string): Uint8Array {
  const snapshot = blobs.blobs.get(`replica/gen/${generation}/snapshot.db`);
  if (!snapshot) throw new Error(`no snapshot in ${generation}`);
  return snapshot;
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function otherThreadWriter(file: string, ms: number): Promise<number> {
  const source = `
    const { DatabaseSync } = require("node:sqlite");
    const { workerData, parentPort } = require("node:worker_threads");
    const db = new DatabaseSync(workerData.file);
    db.exec("PRAGMA busy_timeout = 5000");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    const bump = db.prepare("UPDATE counter SET n = n + 1 WHERE k = 'other'");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const until = Date.now() + workerData.ms;
    let i = 0;
    while (Date.now() < until) {
      db.exec("BEGIN IMMEDIATE");
      insert.run("other-".padEnd(1500, "o"));
      bump.run();
      db.exec("COMMIT");
      i++;
      Atomics.wait(pause, 0, 0, 1);
    }
    db.close();
    parentPort.postMessage(i);
  `;
  const worker = new Worker(source, { eval: true, workerData: { file, ms } });
  workers.push(worker);
  return new Promise<number>((resolve, reject) => {
    worker.once("message", (n: number) => resolve(n));
    worker.once("error", reject);
  });
}

const MB = 1024 * 1024;

function killedWriter(file: string, imageMb: number, walMb: number): void {
  const source = `
    const { DatabaseSync } = require("node:sqlite");
    const { statSync } = require("node:fs");
    const [file, imageMb, walMb] = process.argv.slice(1);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE counter (k TEXT PRIMARY KEY, n INTEGER); INSERT INTO counter VALUES ('main', 0), ('other', 0)");
    const rows = Math.ceil((Number(imageMb) * 1024 * 1024) / 4096);
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    db.exec("BEGIN");
    for (let i = 0; i < rows; i++) insert.run(String(i).padEnd(3800, "s"));
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0");
    const update = db.prepare("UPDATE t SET v = ? WHERE id = ?");
    for (let round = 0; statSync(file + "-wal").size < Number(walMb) * 1024 * 1024; round++) {
      db.exec("BEGIN");
      for (let i = 0; i < 200; i++) update.run((round + "-" + i + "-").padEnd(3800, "u"), 1 + ((round * 200 + i) % rows));
      db.exec("COMMIT");
    }
    process.kill(process.pid, "SIGKILL");
  `;
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", source, file, String(imageMb), String(walMb)], { encoding: "utf8" });
  if (run.signal !== "SIGKILL") throw new Error(`the writer was not killed: ${run.stderr}`);
}

async function whileCheckpointLockIsHeld<T>(task: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called only through apply, with the statement as this
  const original = StatementSync.prototype.get;
  const busy = vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (this: StatementSync, ...args: Parameters<typeof original>) {
    return this.sourceSQL.includes("wal_checkpoint(PASSIVE)") ? { busy: 1, log: -1, checkpointed: -1 } : original.apply(this, args);
  });
  try {
    return await task();
  } finally {
    busy.mockRestore();
  }
}

function copiedBackOnThisThread(file: string): { frames: () => number; stop: () => void } {
  const little = endianness() === "LE";
  const backfilled = (): number => {
    try {
      const shm = readFileSync(`${file}-shm`);
      return shm.byteLength < 100 ? 0 : new DataView(shm.buffer, shm.byteOffset, shm.byteLength).getUint32(96, little);
    } catch {
      return 0;
    }
  };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called only through apply, with the statement as this
  const original = StatementSync.prototype.get;
  let frames = 0;
  const spy = vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (this: StatementSync, ...args: Parameters<typeof original>) {
    if (!this.sourceSQL.includes("wal_checkpoint")) return original.apply(this, args);
    const before = backfilled();
    const row = original.apply(this, args);
    frames += Math.max(0, backfilled() - before);
    return row;
  });
  return { frames: () => frames, stop: () => spy.mockRestore() };
}

function checkpointWaitingOnAnotherThread(file: string, busyMs: number): { started: Promise<void>; done: Promise<void> } {
  const source = `
    const { DatabaseSync } = require("node:sqlite");
    const { workerData, parentPort } = require("node:worker_threads");
    const db = new DatabaseSync(workerData.file);
    db.exec("PRAGMA busy_timeout = " + workerData.busyMs);
    parentPort.postMessage("started");
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();
    parentPort.postMessage("done");
  `;
  const worker = new Worker(source, { eval: true, workerData: { file, busyMs } });
  workers.push(worker);
  const message = (expected: string) =>
    new Promise<void>((resolve, reject) => {
      const listen = (value: unknown): void => {
        if (value !== expected) return;
        worker.off("message", listen);
        resolve();
      };
      worker.on("message", listen);
      worker.once("error", reject);
    });
  return { started: message("started"), done: message("done") };
}

async function measured<T>(task: () => Promise<T>): Promise<{ value: T; ms: number; longestMs: number; p99Ms: number; peakBuffers: number; peakRss: number }> {
  const delay = monitorEventLoopDelay({ resolution: 5 });
  const baseline = process.memoryUsage();
  let peakBuffers = 0;
  let peakRss = 0;
  let lastTick = performance.now();
  let longestGap = 0;
  const sampler = setInterval(() => {
    const tick = performance.now();
    longestGap = Math.max(longestGap, tick - lastTick);
    lastTick = tick;
    const usage = process.memoryUsage();
    peakBuffers = Math.max(peakBuffers, usage.arrayBuffers - baseline.arrayBuffers);
    peakRss = Math.max(peakRss, usage.rss - baseline.rss);
  }, 2);
  delay.enable();
  await sleep(50);
  const started = performance.now();
  const value = await task();
  const ms = performance.now() - started;
  await sleep(20);
  delay.disable();
  clearInterval(sampler);
  return { value, ms, longestMs: Math.max(delay.max / 1e6, longestGap), p99Ms: delay.percentile(99) / 1e6, peakBuffers, peakRss };
}

function reportMeasurement(name: string, values: Record<string, number>): void {
  const report = process.env.KESTREL_REPLICATION_SNAPSHOT_TEST_REPORT;
  const rounded = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value * 10) / 10]));
  if (report) appendFileSync(report, `${JSON.stringify({ test: name, ...rounded })}\n`);
}

describe("replication/sqlite snapshot image", () => {
  const states: Array<[string, (l: ReturnType<typeof live>) => Promise<Replication>]> = [
    [
      "a WAL that holds no frames",
      async (l) => {
        l.insert(200, 900);
        l.app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        return l.start();
      },
    ],
    [
      "a WAL written before the first snapshot, which the snapshot copies back before it reads the database file",
      async (l) => {
        l.insert(50, 900);
        l.app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const repl = l.start();
        for (let i = 0; i < 30; i++) l.insert(20, 1800);
        return repl;
      },
    ],
    [
      "a WAL whose frames up to the snapshot's read transaction are copied back and whose frames after it are not",
      async (l) => {
        l.app.exec("PRAGMA wal_autocheckpoint = 0");
        for (let i = 0; i < 10; i++) l.insert(20, 1800);
        const repl = l.start();
        let committed = false;
        io.beforeRead = (path) => {
          if (committed || path !== `${l.file}-wal`) return;
          committed = true;
          for (let i = 0; i < 10; i++) l.insert(20, 2600);
        };
        return repl;
      },
    ],
    [
      "a WAL none of whose frames are copied back yet",
      async (l) => {
        l.insert(50, 900);
        l.app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const repl = l.start();
        expectOk(await repl.sync());
        for (let i = 0; i < 30; i++) l.insert(20, 1800);
        return repl;
      },
    ],
    [
      "a WAL that started over and still holds frames of its previous lineage behind the new ones",
      async (l) => {
        l.insert(40, 900);
        const repl = l.start({ checkpointSeconds: 1 });
        for (let i = 0; i < 20; i++) l.insert(20, 2000);
        l.clock.advance(2_000);
        expect(expectOk(await repl.sync()).checkpointed).toBe(true);
        l.insert(3, 700);
        return repl;
      },
    ],
    [
      "a WAL every frame of which a checkpoint already copied back",
      async (l) => {
        l.insert(40, 900);
        const repl = l.start({ checkpointSeconds: 1 });
        for (let i = 0; i < 20; i++) l.insert(20, 2000);
        l.clock.advance(2_000);
        expect(expectOk(await repl.sync()).checkpointed).toBe(true);
        return repl;
      },
    ],
  ];

  it.each(states)("is the database file with every committed frame applied, byte for byte, for %s", async (_name, prepare) => {
    const l = live();
    const repl = await prepare(l);
    const generation = expectOk(await repl.snapshot()).generation;
    io.beforeRead = null;
    expect(same(snapshotOf(l.blobs, generation), referenceSnapshot(l.file))).toBe(true);
    expect(await restored(l.blobs, l.dir, { generation })).toMatchObject({ ...fingerprint(l.app), check: "ok" });
  });

  it.each(states)("is the same image, byte for byte, when another connection holds the checkpoint lock, for %s", async (_name, prepare) => {
    const l = live();
    const repl = await prepare(l);
    const generation = expectOk(await whileCheckpointLockIsHeld(() => repl.snapshot())).generation;
    io.beforeRead = null;
    expect(same(snapshotOf(l.blobs, generation), referenceSnapshot(l.file))).toBe(true);
    expect(await restored(l.blobs, l.dir, { generation })).toMatchObject({ ...fingerprint(l.app), check: "ok" });
  });

  it("is the database file with every committed frame applied, byte for byte, after transactions that shrink and grow the database", async () => {
    const l = live({ autoVacuum: true });
    l.insert(100, 2000);
    l.app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const repl = l.start();
    expectOk(await repl.sync());
    for (let i = 0; i < 10; i++) l.insert(30, 3000);
    l.app.exec("DELETE FROM t WHERE id % 3 <> 0; PRAGMA incremental_vacuum");
    for (let i = 0; i < 5; i++) l.insert(10, 4000);
    l.app.exec("DELETE FROM t WHERE id > 200; PRAGMA incremental_vacuum");
    l.insert(15, 1200);
    const generation = expectOk(await repl.snapshot()).generation;
    expect(same(snapshotOf(l.blobs, generation), referenceSnapshot(l.file))).toBe(true);
    expect(await restored(l.blobs, l.dir, { generation })).toMatchObject({ ...fingerprint(l.app), check: "ok" });
    l.app.exec("DELETE FROM t WHERE id % 2 = 0; PRAGMA incremental_vacuum");
    l.insert(20, 2500);
    const busy = expectOk(await whileCheckpointLockIsHeld(() => repl.snapshot())).generation;
    expect(same(snapshotOf(l.blobs, busy), referenceSnapshot(l.file))).toBe(true);
    expect(await restored(l.blobs, l.dir, { generation: busy })).toMatchObject({ ...fingerprint(l.app), check: "ok" });
  });
});

const IMAGE_MB = Number(process.env.KESTREL_REPLICATION_SNAPSHOT_TEST_IMAGE_MB ?? "24");
const WAL_MB = Number(process.env.KESTREL_REPLICATION_SNAPSHOT_TEST_WAL_MB ?? String(IMAGE_MB * 2));

describe("replication/sqlite snapshot of a large database", () => {
  function large(l: ReturnType<typeof live>) {
    const width = 3800;
    const rows = Math.ceil((IMAGE_MB * MB) / 4096);
    const insert = l.app.prepare("INSERT INTO t (v) VALUES (?)");
    l.app.exec("BEGIN");
    for (let i = 0; i < rows; i++) insert.run(`${i}-`.padEnd(width, "s"));
    l.app.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    const update = l.app.prepare("UPDATE t SET v = ? WHERE id = ?");
    return () => {
      for (let round = 0; l.walSize() < WAL_MB * MB; round++) {
        l.app.exec("BEGIN");
        for (let i = 0; i < 200; i++) update.run(`${round}-${i}-`.padEnd(width, "u"), 1 + ((round * 200 + i) % rows));
        for (let i = 0; i < 2; i++) insert.run(`${round}-g-`.padEnd(width, "g"));
        l.app.exec("COMMIT");
      }
    };
  }

  it(`keeps every synchronous slice of the first snapshot of a WAL its writer never checkpoints under 250 ms, copies it back off this thread and holds about one image in memory (${IMAGE_MB} MB image, ${WAL_MB} MB WAL)`, async () => {
    const l = live();
    const grow = large(l);
    l.app.exec("PRAGMA wal_autocheckpoint = 0");
    const repl = l.start({ checkpointBytes: 4 * MB });
    grow();
    const walBytes = l.walSize();
    const copied = copiedBackOnThisThread(l.file);
    let run: Awaited<ReturnType<typeof measured<Awaited<ReturnType<Replication["sync"]>>>>>;
    try {
      run = await measured(() => repl.sync());
    } finally {
      copied.stop();
    }
    const generation = expectOk(run.value).generation;
    const snapshotBytes = snapshotOf(l.blobs, generation).byteLength;
    reportMeasurement("first snapshot", { imageBytes: statSync(l.file).size, walBytes, snapshotBytes, syncMs: run.ms, longestSliceMs: run.longestMs, p99SliceMs: run.p99Ms, framesCopiedOnThisThread: copied.frames(), peakArrayBuffersMb: run.peakBuffers / MB, peakRssMb: run.peakRss / MB });
    expect(copied.frames()).toBe(0);
    expect(run.longestMs).toBeLessThan(250);
    expect(run.peakBuffers).toBeLessThan(snapshotBytes * 1.5 + 16 * MB);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation, n: fingerprint(l.app).n, s: fingerprint(l.app).s, check: "ok" });
  }, 600_000);

  it(`keeps every synchronous slice of a periodic snapshot under 250 ms and holds about one image in memory while it applies the WAL frames written since the generation before it (${IMAGE_MB} MB image, ${WAL_MB} MB WAL)`, async () => {
    const l = live();
    const grow = large(l);
    const repl = l.start({ snapshotSeconds: 60 });
    const first = expectOk(await repl.sync()).generation;
    grow();
    expectOk(await repl.sync());
    l.clock.advance(61_000);
    const walBytes = l.walSize();
    const run = await measured(() => repl.sync());
    const generation = expectOk(run.value).generation;
    expect(generation > first).toBe(true);
    const snapshotBytes = snapshotOf(l.blobs, generation).byteLength;
    reportMeasurement("periodic snapshot", { imageBytes: statSync(l.file).size, walBytes, snapshotBytes, syncMs: run.ms, longestSliceMs: run.longestMs, p99SliceMs: run.p99Ms, peakArrayBuffersMb: run.peakBuffers / MB, peakRssMb: run.peakRss / MB });
    expect(run.longestMs).toBeLessThan(250);
    expect(run.peakBuffers).toBeLessThan(snapshotBytes * 1.5 + 16 * MB);
    expect(same(snapshotOf(l.blobs, generation), referenceSnapshot(l.file))).toBe(true);
    expect(await restored(l.blobs, l.dir, { generation })).toMatchObject({ n: fingerprint(l.app).n, s: fingerprint(l.app).s, check: "ok" });
  }, 600_000);
});

describe("replication/sqlite first sync after the process before it was killed", () => {
  it(`copies the WAL that process left behind back into the database off this thread, keeps every synchronous slice of the first sync under 250 ms and holds about one image in memory (${IMAGE_MB} MB image, ${WAL_MB} MB WAL)`, async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-snap-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    killedWriter(file, IMAGE_MB, WAL_MB);
    const walBytes = statSync(`${file}-wal`).size;
    expect(walBytes).toBeGreaterThanOrEqual(WAL_MB * MB);
    const blobs = memoryBlobs();
    const copied = copiedBackOnThisThread(file);
    const constructing = performance.now();
    const repl = createReplicationSqlite({ file, prefix: "replica/", checkpointBytes: 4 * MB, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: false }, blobs, () => Date.UTC(2026, 0, 1), { checkIntervalMs: 3_600_000 });
    const constructMs = performance.now() - constructing;
    open.push(repl);
    let run: Awaited<ReturnType<typeof measured<Awaited<ReturnType<Replication["sync"]>>>>>;
    try {
      run = await measured(() => repl.sync());
    } finally {
      copied.stop();
    }
    const generation = expectOk(run.value).generation;
    const snapshotBytes = snapshotOf(blobs, generation).byteLength;
    reportMeasurement("first sync after a kill", { imageBytes: statSync(file).size, walBytes, snapshotBytes, constructMs, syncMs: run.ms, longestSliceMs: run.longestMs, p99SliceMs: run.p99Ms, framesCopiedOnThisThread: copied.frames(), peakArrayBuffersMb: run.peakBuffers / MB, peakRssMb: run.peakRss / MB });
    expect(copied.frames()).toBe(0);
    expect(run.longestMs).toBeLessThan(250);
    expect(run.peakBuffers).toBeLessThan(snapshotBytes * 1.5 + 16 * MB);
    const app = new DatabaseSync(file);
    apps.push(app);
    expect(await restored(blobs, dir)).toMatchObject({ generation, n: fingerprint(app).n, s: fingerprint(app).s, check: "ok" });
  }, 600_000);
});

describe("replication/sqlite snapshot while a checkpoint on another thread waits for the module's read transaction", () => {
  it("reads the WAL from its first frame and takes the snapshot, byte for byte, instead of failing", async () => {
    const l = live();
    l.insert(200, 900);
    const repl = l.start();
    const first = expectOk(await repl.sync()).generation;
    for (let i = 0; i < 20; i++) l.insert(10, 1800);
    const waiting = checkpointWaitingOnAnotherThread(l.file, 1_500);
    await waiting.started;
    await sleep(100);
    const generation = expectOk(await repl.snapshot()).generation;
    expect(generation > first).toBe(true);
    expect(same(snapshotOf(l.blobs, generation), referenceSnapshot(l.file))).toBe(true);
    expect(await restored(l.blobs, l.dir, { generation })).toMatchObject({ ...fingerprint(l.app), check: "ok" });
    await waiting.done;
    l.insert(5, 900);
    expectOk(await repl.sync());
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation, ...fingerprint(l.app), check: "ok" });
  }, 30_000);
});

describe("replication/sqlite snapshot while other connections commit", () => {
  it("captures a state that one transaction left behind, loses no frame committed after it, and restores the same bytes with the plain rebuild", async () => {
    const l = live();
    l.insert(400, 1000);
    const repl = l.start({ checkpointSeconds: 1, snapshotSeconds: 1 });
    io.beforeRead = (path) => (path === l.file || path === `${l.file}-wal` ? sleep(2) : undefined);
    const other = otherThreadWriter(l.file, 1500);
    let writing = true;
    const main = (async () => {
      while (writing) {
        l.counted();
        await sleep(1);
      }
    })();
    const generations: string[] = [];
    for (let round = 0; round < 4; round++) {
      generations.push(expectOk(await repl.sync()).generation);
      l.clock.advance(2_000);
      await sleep(30);
    }
    await other;
    writing = false;
    await main;
    io.beforeRead = null;
    expect(new Set(generations).size).toBe(4);
    for (const generation of generations) {
      const point = expectOk(await repl.points()).find((p) => p.generation === generation && p.kind === "snapshot");
      const state = await restored(l.blobs, l.dir, { generation, at: point?.at ?? 0 });
      expect(state.check).toBe("ok");
      expect(state.mainRows).toBe(state.main);
      expect(state.otherRows).toBe(state.other);
    }
    expectOk(await repl.sync());
    const latest = await restored(l.blobs, l.dir);
    expect(latest).toMatchObject({ ...fingerprint(l.app), check: "ok" });
    expect(same((await referenceRestore(l.blobs, "replica/")).image, latest.bytes)).toBe(true);
  }, 60_000);
});

describe("replication/sqlite snapshot interrupted by the end of the process", () => {
  async function dueForSnapshot() {
    const l = live();
    l.insert(300, 1500);
    const repl = l.start({ snapshotSeconds: 60 });
    const first = expectOk(await repl.sync()).generation;
    for (let i = 0; i < 10; i++) l.counted();
    expectOk(await repl.sync());
    for (let i = 0; i < 10; i++) l.counted();
    l.clock.advance(61_000);
    return { ...l, repl, first };
  }

  it("restores the generation before it, with every frame the sync shipped, when the process dies while the snapshot reads the database", async () => {
    const { repl, blobs, dir, file, app, first } = await dueForSnapshot();
    let reading = false;
    io.beforeRead = (path) => {
      if (path !== file) return undefined;
      reading = true;
      return hang(undefined);
    };
    void repl.sync();
    while (!reading) await sleep(1);
    expect(await restored(blobs, dir)).toMatchObject({ generation: first, ...fingerprint(app), check: "ok" });
  });

  it("restores the generation before it, with every frame the sync shipped, when the process dies while the snapshot is uploaded", async () => {
    const { repl, blobs, dir, app, first } = await dueForSnapshot();
    const put = blobs.put.bind(blobs);
    let uploading = false;
    blobs.put = async (key, data, options) => {
      if (!key.endsWith("/snapshot.db")) return put(key, data, options);
      uploading = true;
      return hang(err(failure("TRANSIENT", "the process ended")));
    };
    void repl.sync();
    while (!uploading) await sleep(1);
    expect(await restored(blobs, dir)).toMatchObject({ generation: first, ...fingerprint(app), check: "ok" });
  });

  it("restores the new generation when the process dies right after its snapshot was uploaded", async () => {
    const { repl, blobs, dir, app, first } = await dueForSnapshot();
    const put = blobs.put.bind(blobs);
    let uploaded = false;
    blobs.put = async (key, data, options) => {
      if (uploaded) return hang(err(failure("TRANSIENT", "the process ended")));
      const result = await put(key, data, options);
      if (key.endsWith("/snapshot.db")) uploaded = true;
      return result;
    };
    void repl.sync();
    while (!uploaded) await sleep(1);
    const state = await restored(blobs, dir);
    expect(state.generation > first).toBe(true);
    expect(state).toMatchObject({ ...fingerprint(app), check: "ok" });
  });
});

describe("replication/sqlite WAL before the first generation", () => {
  it("keeps the WAL near checkpointBytes before the first sync, and the first sync and every later one ship every frame", async () => {
    const l = live();
    const repl = l.start({ checkpointBytes: 256 * 1024, checkpointSeconds: 1 }, { checkIntervalMs: 5 });
    let maxWal = 0;
    for (let i = 0; i < 120; i++) {
      l.insert(10, 12_000);
      maxWal = Math.max(maxWal, l.walSize());
      await sleep(2);
    }
    expect(maxWal).toBeLessThan(2 * 1024 * 1024);
    const list = l.blobs.list.bind(l.blobs);
    let listing = true;
    l.blobs.list = async (prefix) => {
      l.blobs.list = list;
      await sleep(300);
      listing = false;
      return list(prefix);
    };
    const first = repl.sync();
    while (listing) {
      l.insert(10, 12_000);
      maxWal = Math.max(maxWal, l.walSize());
      await sleep(2);
    }
    expectOk(await first);
    expect(maxWal).toBeLessThan(2 * 1024 * 1024);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ ...fingerprint(l.app), check: "ok" });
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 30; i++) {
        l.insert(10, 12_000);
        await sleep(1);
      }
      l.clock.advance(2_000);
      expectOk(await repl.sync());
      expect(await restored(l.blobs, l.dir)).toMatchObject({ ...fingerprint(l.app), check: "ok" });
    }
  }, 60_000);

  it("keeps the WAL bounded before the first generation while write transactions stay open across turns of the event loop", async () => {
    const l = live();
    const width = 3800;
    const rows = 2000;
    const insert = l.app.prepare("INSERT INTO t (v) VALUES (?)");
    l.app.exec("BEGIN");
    for (let i = 0; i < rows; i++) insert.run(`${i}-`.padEnd(width, "r"));
    l.app.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    const repl = l.start({ checkpointBytes: 256 * 1024 }, { checkIntervalMs: 20 });
    const list = l.blobs.list.bind(l.blobs);
    let writing = true;
    l.blobs.list = async (prefix) => {
      while (writing) await sleep(5);
      return list(prefix);
    };
    const first = repl.sync();
    const update = l.app.prepare("UPDATE t SET v = ? WHERE id = ?");
    let maxWal = 0;
    for (let round = 0, written = 0; written < 48 * MB; round++, written += 20 * 4096) {
      l.app.exec("BEGIN IMMEDIATE");
      for (let i = 0; i < 10; i++) update.run(`${round}-${i}-a`.padEnd(width, "a"), 1 + ((round * 20 + i) % rows));
      await sleep(2);
      for (let i = 0; i < 10; i++) update.run(`${round}-${i}-b`.padEnd(width, "b"), 1 + ((round * 20 + 10 + i) % rows));
      l.app.exec("COMMIT");
      maxWal = Math.max(maxWal, l.walSize());
      await new Promise((resolve) => setImmediate(resolve));
    }
    writing = false;
    expectOk(await first);
    l.blobs.list = list;
    reportMeasurement("WAL before the first generation", { maxWalMb: maxWal / MB });
    expect(maxWal).toBeLessThan(8 * MB);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ ...fingerprint(l.app), check: "ok" });
    for (let i = 0; i < 30; i++) l.counted();
    l.clock.advance(2_000);
    expectOk(await repl.sync());
    expect(await restored(l.blobs, l.dir)).toMatchObject({ ...fingerprint(l.app), check: "ok" });
  }, 60_000);

  it("seals a first snapshot when another connection committed and then truncated the WAL before the first sync", async () => {
    const l = live();
    const repl = l.start();
    l.insert(20, 900);
    l.app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(l.walSize()).toBe(0);
    const sealed = expectOk(await repl.seal());
    if (sealed === null) throw new Error("expected a seal");
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation: sealed.generation, ...fingerprint(l.app), check: "ok" });
  });

  it("seals a first snapshot of everything committed before the first sync after checkpoints copied it into the database file", async () => {
    const l = live();
    const repl = l.start({ checkpointBytes: 64 * 1024 }, { checkIntervalMs: 5 });
    for (let i = 0; i < 20; i++) l.insert(10, 8000);
    await sleep(100);
    const sealed = expectOk(await repl.seal());
    if (sealed === null) throw new Error("expected a seal");
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation: sealed.generation, ...fingerprint(l.app), check: "ok" });
  });
});

describe("replication/sqlite after quiesce", () => {
  const keys = (blobs: ReturnType<typeof memoryBlobs>, suffix: string) => [...blobs.blobs.keys()].filter((key) => key.endsWith(suffix)).sort();

  it("ships the new frames at a sync and skips the checkpoint, the periodic snapshot and the prune although all three are due", async () => {
    const l = live();
    l.insert(50, 900);
    const repl = l.start({ checkpointSeconds: 1, snapshotSeconds: 1, retentionSeconds: 1 });
    expectOk(await repl.sync());
    l.clock.advance(2_000);
    const second = expectOk(await repl.sync()).generation;
    expect(keys(l.blobs, "/snapshot.db")).toHaveLength(2);
    l.clock.advance(5_000);
    l.insert(20, 900);
    repl.quiesce();
    const synced = expectOk(await repl.sync());
    expect(synced).toMatchObject({ generation: second, checkpointed: false, pruned: 0 });
    expect(synced.frames).toBeGreaterThan(0);
    expect(keys(l.blobs, "/snapshot.db")).toHaveLength(2);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation: second, ...fingerprint(l.app), check: "ok" });
  });

  it("answers TRANSIENT to a snapshot asked for while a generation exists, and writes nothing", async () => {
    const l = live();
    l.insert(50, 900);
    const repl = l.start();
    expectOk(await repl.sync());
    const before = [...l.blobs.blobs.keys()].sort();
    repl.quiesce();
    const refused = await repl.snapshot();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("TRANSIENT");
    expect([...l.blobs.blobs.keys()].sort()).toEqual(before);
  });

  it("still takes the first snapshot of a process without a generation", async () => {
    const l = live();
    l.insert(50, 900);
    const repl = l.start();
    repl.quiesce();
    const generation = expectOk(await repl.sync()).generation;
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation, ...fingerprint(l.app), check: "ok" });
  });
});

describe("replication/sqlite failed snapshot upload", () => {
  it("removes the snapshot key again when its upload fails after the store kept it, so a restore keeps to the generation before it", async () => {
    const l = live();
    l.insert(50, 900);
    const repl = l.start({ snapshotSeconds: 60 });
    const first = expectOk(await repl.sync()).generation;
    l.insert(10, 900);
    l.clock.advance(61_000);
    const put = l.blobs.put.bind(l.blobs);
    l.blobs.put = async (key, data, options) => {
      const stored = await put(key, data, options);
      return key.endsWith("/snapshot.db") ? err(failure("TRANSIENT", "the store kept the object but answered an error")) : stored;
    };
    expect((await repl.sync()).ok).toBe(false);
    l.blobs.put = put;
    expect([...l.blobs.blobs.keys()].filter((key) => key.endsWith("/snapshot.db"))).toEqual([`replica/gen/${first}/snapshot.db`]);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation: first, ...fingerprint(l.app), check: "ok" });
  });

  it("ships no frame and writes no seal while the key of a failed snapshot upload cannot be removed, and continues the generation before it once the key is gone", async () => {
    const l = live();
    l.insert(50, 900);
    const repl = l.start();
    const first = expectOk(await repl.sync()).generation;
    l.insert(10, 900);
    const put = l.blobs.put.bind(l.blobs);
    const remove = l.blobs.remove.bind(l.blobs);
    let unreachable = true;
    l.blobs.put = async (key, data, options) => {
      const stored = await put(key, data, options);
      return unreachable && key.endsWith("/snapshot.db") ? err(failure("TRANSIENT", "the store kept the object but answered an error")) : stored;
    };
    l.blobs.remove = async (key) => (unreachable ? err(failure("TRANSIENT", "the store is unreachable")) : remove(key));
    const keys = (suffix: string) => [...l.blobs.blobs.keys()].filter((key) => key.endsWith(suffix)).sort();
    const segments = () => [...l.blobs.blobs.keys()].filter((key) => key.startsWith(`replica/gen/${first}/wal/`)).sort();
    expect((await repl.snapshot()).ok).toBe(false);
    const atSnapshot = fingerprint(l.app);
    const orphan = keys("/snapshot.db").find((key) => !key.includes(first))?.split("/")[2];
    expect(orphan).toBeDefined();
    const shipped = segments();
    for (let round = 0; round < 3; round++) {
      l.insert(7, 900);
      const synced = await repl.sync();
      expect(synced.ok).toBe(false);
      if (!synced.ok) expect(synced.error.code).toBe("TRANSIENT");
    }
    expect((await repl.seal()).ok).toBe(false);
    expect(segments()).toEqual(shipped);
    expect(keys("/sealed.json")).toEqual([]);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation: orphan, ...atSnapshot, check: "ok" });
    unreachable = false;
    expect(expectOk(await repl.sync()).generation).toBe(first);
    expect(keys("/snapshot.db")).toEqual([`replica/gen/${first}/snapshot.db`]);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation: first, ...fingerprint(l.app), check: "ok" });
  });

  function failingFirstUpload(l: ReturnType<typeof live>, failedRemovals: number) {
    const put = l.blobs.put.bind(l.blobs);
    const remove = l.blobs.remove.bind(l.blobs);
    let snapshots = 0;
    let removals = 0;
    l.blobs.put = async (key, data, options) => {
      const stored = await put(key, data, options);
      if (!key.endsWith("/snapshot.db")) return stored;
      snapshots += 1;
      return snapshots === 1 ? err(failure("TRANSIENT", "the store kept the object but answered an error")) : stored;
    };
    l.blobs.remove = async (key) => {
      removals += 1;
      return removals <= failedRemovals ? err(failure("TRANSIENT", "the store is unreachable")) : remove(key);
    };
    return {
      keys: (suffix: string) => [...l.blobs.blobs.keys()].filter((key) => key.endsWith(suffix)).sort(),
      removals: () => removals,
      reachable: () => {
        failedRemovals = 0;
      },
    };
  }

  it("removes the key of a failed first snapshot upload at the next sync before it uploads the first generation", async () => {
    const l = live();
    l.insert(50, 900);
    const repl = l.start();
    const store = failingFirstUpload(l, 1);
    expect((await repl.sync()).ok).toBe(false);
    const [orphan] = store.keys("/snapshot.db");
    expect(orphan).toBeDefined();
    l.insert(5, 900);
    const generation = expectOk(await repl.sync()).generation;
    expect(store.removals()).toBeGreaterThanOrEqual(2);
    expect(store.keys("/snapshot.db")).toEqual([`replica/gen/${generation}/snapshot.db`]);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation, ...fingerprint(l.app), check: "ok" });
  });

  it("uploads no first generation and writes no seal while the key of a failed first snapshot upload cannot be removed", async () => {
    const l = live();
    l.insert(50, 900);
    const repl = l.start();
    const store = failingFirstUpload(l, Number.POSITIVE_INFINITY);
    expect((await repl.sync()).ok).toBe(false);
    const orphans = store.keys("/snapshot.db");
    expect(orphans).toHaveLength(1);
    for (let round = 0; round < 2; round++) {
      l.insert(3, 900);
      const synced = await repl.sync();
      expect(synced.ok).toBe(false);
      if (!synced.ok) expect(synced.error.code).toBe("TRANSIENT");
    }
    const sealed = await repl.seal();
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.error.code).toBe("TRANSIENT");
    expect(store.keys("/snapshot.db")).toEqual(orphans);
    expect(store.keys("/sealed.json")).toEqual([]);
    store.reachable();
    const generation = expectOk(await repl.sync()).generation;
    expect(store.keys("/snapshot.db")).toEqual([`replica/gen/${generation}/snapshot.db`]);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ generation, ...fingerprint(l.app), check: "ok" });
  });

  it("removes the key of a failed first snapshot upload at a seal that has nothing to write", async () => {
    const l = live();
    l.insert(50, 900);
    l.app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const repl = l.start();
    const store = failingFirstUpload(l, 1);
    expect((await repl.sync()).ok).toBe(false);
    expect(store.keys("/snapshot.db")).toHaveLength(1);
    expect(expectOk(await repl.seal())).toBeNull();
    expect(store.keys("/snapshot.db")).toEqual([]);
  });
});
