import { mkdtempSync, rmSync } from "node:fs";
import type * as FsPromisesModule from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boot, type Kestrel } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { restoreFromBlobs } from "./impl.ts";
import replication from "./module.ts";

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
      blobs.set(key, new Uint8Array(data));
      return ok();
    },
    async get(key) {
      return ok(blobs.get(key) ?? null);
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
const apps: DatabaseSync[] = [];
let kestrel: Kestrel | null = null;

beforeEach(() => {
  io.beforeRead = null;
});

afterEach(async () => {
  io.beforeRead = null;
  await kestrel?.stop({ timeoutMs: 1_000 });
  kestrel = null;
  for (const a of apps.splice(0)) a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function started(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-stop-"));
  dirs.push(dir);
  const file = join(dir, "live.db");
  const app = new DatabaseSync(file);
  apps.push(app);
  app.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const insert = app.prepare("INSERT INTO t (v) VALUES (?)");
  const write = (n: number, width = 3800) => {
    app.exec("BEGIN");
    for (let i = 0; i < n; i++) insert.run(`${i}-`.padEnd(width, "w"));
    app.exec("COMMIT");
  };
  const blobs = memoryBlobs();
  const store = defineModule({ name: "blobstore/memory", provides: [BLOBSTORE], requires: [], configSchema: z.object({}).strict(), setup: async () => blobs });
  kestrel = await boot({
    config: { modules: [{ use: "./blobstore-memory", config: {} }, { use: "./replication-sqlite", config: { file, restoreOnStart: false, ...config } }], triggers: [], http: null },
    modules: [store, replication],
    pipelines: [definePipeline({ name: "replicate", steps: ["replication.sync"] })],
    logger: silentLogger,
  });
  await kestrel.start();
  const k = kestrel;
  const sync = () => k.run("replicate", { trigger: { kind: "cron", name: "* * * * *" } });
  const fingerprint = (db: DatabaseSync) => boundaryCast<{ n: number; s: number | null }>(db.prepare("SELECT count(*) AS n, sum(length(v) * id) AS s FROM t").get(), "host");
  const restored = async () => {
    const out = join(dir, `restore-${Math.random().toString(36).slice(2)}.db`);
    const result = expectOk(await restoreFromBlobs(blobs, "replica/", {}, out));
    const db = new DatabaseSync(out);
    try {
      return { ...result, ...fingerprint(db), check: boundaryCast<{ integrity_check: string }>(db.prepare("PRAGMA integrity_check").get(), "host").integrity_check };
    } finally {
      db.close();
    }
  };
  const keys = (suffix: string) => [...blobs.blobs.keys()].filter((key) => key.endsWith(suffix)).sort();
  const slowDatabaseReads = (ms: number) => {
    let reads = 0;
    io.beforeRead = (path) => {
      if (path !== file) return undefined;
      reads += 1;
      return sleep(ms);
    };
    return async () => {
      while (reads === 0) await sleep(1);
    };
  };
  return { k, file, app, write, sync, live: () => fingerprint(app), restored, keys, slowDatabaseReads };
}

describe("replication/sqlite stop during a snapshot", () => {
  it("abandons a periodic snapshot, so stop() ends long before its timeout, and teardown ships the last frames into the generation before it and seals that", async () => {
    const { k, write, sync, live, restored, keys, slowDatabaseReads } = await started({ snapshotSeconds: 1 });
    write(2000);
    expect((await sync()).status).toBe(200);
    const [first] = keys("/snapshot.db");
    write(50);
    await sleep(1_100);
    const reading = slowDatabaseReads(150);
    const running = sync();
    await reading();
    const asked = performance.now();
    const stopping = k.stop({ timeoutMs: 20_000 });
    write(20);
    expect(await stopping).toEqual({ drained: true });
    expect(performance.now() - asked).toBeLessThan(2_000);
    expect((await running).status).toBe(200);
    kestrel = null;
    expect(keys("/snapshot.db")).toEqual([first]);
    expect(keys("/sealed.json")).toEqual([first?.replace("/snapshot.db", "/sealed.json")]);
    expect(await restored()).toMatchObject({ ...live(), check: "ok" });
  }, 30_000);

  it("finishes the first snapshot of the process before teardown, which then ships the frames committed meanwhile and seals the new generation", async () => {
    const { k, write, sync, live, restored, keys, slowDatabaseReads } = await started();
    write(2000);
    const reading = slowDatabaseReads(100);
    const running = sync();
    await reading();
    const stopping = k.stop({ timeoutMs: 20_000 });
    write(20);
    expect(await stopping).toEqual({ drained: true });
    expect((await running).status).toBe(200);
    kestrel = null;
    expect(keys("/snapshot.db")).toHaveLength(1);
    expect(keys("/sealed.json")).toEqual(keys("/snapshot.db").map((key) => key.replace("/snapshot.db", "/sealed.json")));
    expect(await restored()).toMatchObject({ ...live(), check: "ok" });
  }, 30_000);
});
