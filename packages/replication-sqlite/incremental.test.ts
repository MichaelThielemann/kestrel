import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type * as FsModule from "node:fs";
import type * as FsPromisesModule from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { ok } from "@michaelthielemann/kestrel/result";
import { createReplicationSqlite, restoreFromBlobs, type Replication } from "./impl.ts";
import { FRAME_HEADER_SIZE, frameSize, parseWalHeader, WAL_HEADER_SIZE } from "./wal.ts";

const io = vi.hoisted(() => ({ reads: [] as Array<{ path: string | null; requested: number; read: number }>, fds: new Map<number, string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const data = actual.readFileSync(...args);
      io.reads.push({ path: String(args[0]), requested: data.length, read: data.length });
      return data;
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      io.fds.set(fd, String(args[0]));
      return fd;
    },
    readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      const read = actual.readSync(fd, buffer, offset, length, position);
      io.reads.push({ path: io.fds.get(fd) ?? null, requested: length, read });
      return read;
    },
  };
});

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
          const result = await read(buffer, offset, length, position);
          io.reads.push({ path, requested: length, read: result.bytesRead });
          return result;
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
    async put(k, data) {
      blobs.set(k, new Uint8Array(data));
      return ok();
    },
    async get(k) {
      return ok(blobs.get(k) ?? null);
    },
    async remove(k) {
      blobs.delete(k);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (b) blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(p) {
      return ok([...blobs].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.byteLength })));
    },
  };
}

const dirs: string[] = [];
const open: Replication[] = [];
const apps: DatabaseSync[] = [];

beforeEach(() => {
  io.reads.length = 0;
});

afterEach(() => {
  for (const r of open.splice(0)) r.close();
  for (const a of apps.splice(0)) a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(overrides: { checkpointBytes?: number; checkpointSeconds?: number } = {}, options: { checkIntervalMs?: number } = {}, blobs = memoryBlobs()) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-inc-"));
  dirs.push(dir);
  const file = join(dir, "live.db");
  const app = new DatabaseSync(file);
  apps.push(app);
  app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  let t = Date.UTC(2026, 0, 1);
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const config = { file, prefix: "replica/", checkpointBytes: 1024 * 1024 * 1024, checkpointSeconds: 100_000, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: true, ...overrides };
  const repl = createReplicationSqlite(config, blobs, clock.now, options);
  open.push(repl);
  const stmt = app.prepare("INSERT INTO t (v) VALUES (?)");
  const insert = (n: number, width = 100) => {
    app.exec("BEGIN");
    for (let i = 0; i < n; i++) stmt.run(`${i}-`.padEnd(width, "x"));
    app.exec("COMMIT");
  };
  const fingerprint = (db: DatabaseSync) => boundaryCast<{ n: number; s: number | null }>(db.prepare("SELECT count(*) AS n, sum(length(v) * id) AS s FROM t").get(), "host");
  const restored = async (target: { at?: number } = {}) => {
    const out = join(dir, `restore-${Math.random().toString(36).slice(2)}.db`);
    expectOk(await restoreFromBlobs(blobs, "replica/", target, out));
    const db = new DatabaseSync(out);
    const result = { ...fingerprint(db), check: boundaryCast<{ integrity_check: string }>(db.prepare("PRAGMA integrity_check").get(), "host").integrity_check };
    db.close();
    return result;
  };
  const walSize = () => {
    try {
      return statSync(`${file}-wal`).size;
    } catch {
      return 0;
    }
  };
  return { file, app, blobs, repl, clock, insert, live: () => fingerprint(app), restored, walSize };
}

describe("replication/sqlite incremental WAL shipping", () => {
  it("reads only the frames written since the last sync, in bounded chunks", async () => {
    const { file, repl, insert, walSize, restored, live } = setup();
    insert(10);
    expectOk(await repl.sync());
    for (let i = 0; i < 40; i++) insert(50, 4000);
    expect(walSize()).toBeGreaterThan(8 * 1024 * 1024);

    io.reads.length = 0;
    expectOk(await repl.sync());
    const firstPass = io.reads.filter((r) => r.path === `${file}-wal`);
    expect(firstPass.length).toBeGreaterThan(1);
    expect(Math.max(...io.reads.map((r) => r.requested))).toBeLessThanOrEqual(1024 * 1024);

    insert(1);
    io.reads.length = 0;
    expectOk(await repl.sync());
    const secondPass = io.reads.reduce((sum, r) => sum + r.read, 0);
    expect(secondPass).toBeLessThan(256 * 1024);
    expect(await restored()).toMatchObject({ ...live(), check: "ok" });
  });

  it("never ships a partial or torn frame at the end of the WAL", async () => {
    const { file, repl, insert, restored, live } = setup();
    insert(5);
    expectOk(await repl.sync());
    insert(20);
    const wal = new Uint8Array(readFileSync(`${file}-wal`));
    const header = parseWalHeader(wal);
    if (!header) throw new Error("no WAL header");
    const size = frameSize(header.pageSize);
    const frames = Math.floor((wal.byteLength - WAL_HEADER_SIZE) / size);
    const torn = wal.slice(WAL_HEADER_SIZE + (frames - 1) * size, WAL_HEADER_SIZE + frames * size);
    const view = new DataView(torn.buffer);
    view.setUint32(0, 1);
    view.setUint32(4, 1);
    torn.fill(0xab, FRAME_HEADER_SIZE);
    appendFileSync(`${file}-wal`, torn);
    appendFileSync(`${file}-wal`, torn.subarray(0, size / 2));

    expectOk(await repl.sync());
    expect(await restored()).toMatchObject({ ...live(), check: "ok" });
    insert(3);
    expectOk(await repl.sync());
    expect(await restored()).toMatchObject({ ...live(), check: "ok" });
  });

  it("frames committed while a segment upload is in flight survive the checkpoint that follows", async () => {
    const blobs = memoryBlobs();
    const put = blobs.put.bind(blobs);
    let writeDuringUpload: (() => void) | null = null;
    blobs.put = async (key, data, options) => {
      if (key.includes("/wal/") && writeDuringUpload) {
        const write = writeDuringUpload;
        writeDuringUpload = null;
        write();
      }
      return put(key, data, options);
    };
    const { repl, insert, clock, restored, live } = setup({ checkpointSeconds: 1 }, {}, blobs);
    insert(5);
    expectOk(await repl.sync());
    clock.advance(2_000);
    insert(5);
    writeDuringUpload = () => insert(7);
    expect(expectOk(await repl.sync()).checkpointed).toBe(true);
    expect(live().n).toBe(17);
    expect(await restored()).toMatchObject({ ...live(), check: "ok" });
  });

  it("a sync started while another is running joins it instead of overlapping", async () => {
    const blobs = memoryBlobs();
    const put = blobs.put.bind(blobs);
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    blobs.put = async (key, data, options) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return put(key, data, options);
    };
    const { repl, insert } = setup({}, {}, blobs);
    insert(5);
    const first = repl.sync();
    const second = repl.sync();
    await sleep(20);
    release();
    const [a, b] = [expectOk(await first), expectOk(await second)];
    expect(b).toEqual(a);
    expect(maxActive).toBe(1);
    expect([...blobs.blobs.keys()].filter((k) => k.endsWith("/snapshot.db"))).toHaveLength(1);
  });

  it("keeps the WAL bounded under sustained writes between syncs and restores every point", async () => {
    const { repl, insert, walSize, clock, restored, live } = setup({ checkpointBytes: 256 * 1024 }, { checkIntervalMs: 5 });
    insert(10);
    expectOk(await repl.sync());
    const points: Array<{ at: number; n: number; s: number | null }> = [];
    let maxWal = 0;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 40; i++) {
        insert(10, 12_000);
        maxWal = Math.max(maxWal, walSize());
        await sleep(2);
      }
      clock.advance(60_000);
      expectOk(await repl.sync());
      points.push({ at: clock.now(), ...live() });
      clock.advance(1_000);
    }
    expect(maxWal).toBeLessThan(2 * 1024 * 1024);
    expect((await repl.status()).lastCheckpointAt).not.toBeNull();
    for (const p of points) expect(await restored({ at: p.at })).toMatchObject({ n: p.n, s: p.s, check: "ok" });
  });
});
