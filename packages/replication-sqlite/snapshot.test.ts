import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type * as FsPromisesModule from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
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
      "a WAL none of whose frames are copied back yet",
      async (l) => {
        l.insert(50, 900);
        l.app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const repl = l.start();
        for (let i = 0; i < 30; i++) l.insert(20, 1800);
        return repl;
      },
    ],
    [
      "a WAL whose first frames another connection copied back",
      async (l) => {
        l.app.exec("PRAGMA wal_autocheckpoint = 0");
        for (let i = 0; i < 10; i++) l.insert(20, 1800);
        const repl = l.start();
        l.app.exec("PRAGMA wal_checkpoint(PASSIVE)");
        for (let i = 0; i < 10; i++) l.insert(20, 2600);
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
    const expected = referenceSnapshot(l.file);
    const generation = expectOk(await repl.snapshot()).generation;
    expect(same(snapshotOf(l.blobs, generation), expected)).toBe(true);
    expect(await restored(l.blobs, l.dir, { generation })).toMatchObject({ ...fingerprint(l.app), check: "ok" });
  });

  it("is the database file with every committed frame applied, byte for byte, after transactions that shrink and grow the database", async () => {
    const l = live({ autoVacuum: true });
    l.insert(100, 2000);
    l.app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const repl = l.start();
    for (let i = 0; i < 10; i++) l.insert(30, 3000);
    l.app.exec("DELETE FROM t WHERE id % 3 <> 0; PRAGMA incremental_vacuum");
    for (let i = 0; i < 5; i++) l.insert(10, 4000);
    l.app.exec("DELETE FROM t WHERE id > 200; PRAGMA incremental_vacuum");
    l.insert(15, 1200);
    const expected = referenceSnapshot(l.file);
    const generation = expectOk(await repl.snapshot()).generation;
    expect(same(snapshotOf(l.blobs, generation), expected)).toBe(true);
    expect(await restored(l.blobs, l.dir, { generation })).toMatchObject({ ...fingerprint(l.app), check: "ok" });
  });
});

const IMAGE_MB = Number(process.env.KESTREL_REPLICATION_SNAPSHOT_TEST_IMAGE_MB ?? "24");
const WAL_MB = Number(process.env.KESTREL_REPLICATION_SNAPSHOT_TEST_WAL_MB ?? String(IMAGE_MB * 2));

describe("replication/sqlite snapshot of a large database", () => {
  it(`keeps every synchronous slice of the first snapshot under 250 ms and holds about one image in memory (${IMAGE_MB} MB image, ${WAL_MB} MB WAL)`, async () => {
    const width = 3800;
    const l = live();
    const rows = Math.ceil((IMAGE_MB * 1024 * 1024) / 4096);
    l.app.exec("BEGIN");
    const insert = l.app.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < rows; i++) insert.run(`${i}-`.padEnd(width, "s"));
    l.app.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    const repl = l.start();
    const update = l.app.prepare("UPDATE t SET v = ? WHERE id = ?");
    for (let round = 0; l.walSize() < WAL_MB * 1024 * 1024; round++) {
      l.app.exec("BEGIN");
      for (let i = 0; i < 200; i++) update.run(`${round}-${i}-`.padEnd(width, "u"), 1 + ((round * 200 + i) % rows));
      for (let i = 0; i < 2; i++) insert.run(`${round}-g-`.padEnd(width, "g"));
      l.app.exec("COMMIT");
    }
    const image = statSync(l.file).size;
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
    const generation = expectOk(await repl.sync()).generation;
    const took = performance.now() - started;
    await sleep(20);
    delay.disable();
    clearInterval(sampler);
    const longest = Math.max(delay.max / 1e6, longestGap);
    const report = process.env.KESTREL_REPLICATION_SNAPSHOT_TEST_REPORT;
    if (report) appendFileSync(report, `${JSON.stringify({ imageBytes: image, walBytes: l.walSize(), snapshotBytes: snapshotOf(l.blobs, generation).byteLength, syncMs: Math.round(took), longestSliceMs: Math.round(longest * 10) / 10, p99SliceMs: Math.round((delay.percentile(99) / 1e6) * 10) / 10, peakArrayBuffersMb: Math.round(peakBuffers / 1048576), peakRssMb: Math.round(peakRss / 1048576) })}\n`);
    expect(longest).toBeLessThan(250);
    expect(peakBuffers).toBeLessThan(snapshotOf(l.blobs, generation).byteLength * 1.5 + 16 * 1024 * 1024);
    expect(await restored(l.blobs, l.dir)).toMatchObject({ n: fingerprint(l.app).n, s: fingerprint(l.app).s, check: "ok" });
  }, 600_000);
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
});
