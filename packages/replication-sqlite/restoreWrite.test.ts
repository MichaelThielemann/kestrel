import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { ok } from "@michaelthielemann/kestrel/result";
import { applyPendingRestore, createReplicationSqlite, restoreMarker, type Replication } from "./impl.ts";

const diskFull = vi.hoisted(() => ({ paths: new Set<string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      const [path, data] = args;
      if (typeof path === "string" && [...diskFull.paths].some((full) => path.startsWith(full)) && data instanceof Uint8Array) {
        actual.writeFileSync(path, data.subarray(0, Math.floor(data.byteLength / 2)));
        throw Object.assign(new Error(`ENOSPC: no space left on device, write '${path}'`), { code: "ENOSPC" });
      }
      actual.writeFileSync(...args);
    },
  };
});

function memoryBlobs(): Blobstore {
  const blobs = new Map<string, Uint8Array>();
  return {
    put: async (key, data) => (blobs.set(key, new Uint8Array(data)), ok()),
    get: async (key) => ok(blobs.get(key) ?? null),
    remove: async (key) => (blobs.delete(key), ok()),
    move: async (from, to) => {
      const value = blobs.get(from);
      if (value !== undefined) blobs.set(to, value);
      blobs.delete(from);
      return ok();
    },
    list: async (prefix) => ok([...blobs].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.byteLength }))),
  };
}

const dirs: string[] = [];
const open: Array<Replication | DatabaseSync> = [];

afterEach(() => {
  diskFull.paths.clear();
  for (const item of open.splice(0)) item.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-write-"));
  dirs.push(dir);
  const file = join(dir, "live.db");
  const app = new DatabaseSync(file);
  app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const insert = (n: number) => {
    for (let i = 0; i < n; i++) app.prepare("INSERT INTO t (v) VALUES (?)").run("x".repeat(500));
  };
  const repl = createReplicationSqlite({ file, prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: true }, memoryBlobs());
  open.push(repl, app);
  return { dir, file, app, repl, insert };
}

const rows = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return boundaryCast<{ n: number }>(db.prepare("SELECT count(*) AS n FROM t").get(), "host").n;
  } finally {
    db.close();
  }
};

describe("replication/sqlite prepareRestore and a disk that fills while it writes", () => {
  it("leaves no file that the next start would swap over the live database", async () => {
    const { dir, file, app, repl, insert } = setup();
    insert(200);
    expectOk(await repl.sync());
    diskFull.paths.add(restoreMarker(file));
    await expect(repl.prepareRestore({})).rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("live.db.restore"))).toEqual([]);
    expect((await repl.status()).pendingRestore).toBeNull();
    repl.close();
    app.close();
    open.splice(0);
    expect(applyPendingRestore(file)).toBe(false);
    expect(rows(file)).toBe(200);
  });

  it("can prepare the restore again once the disk has room", async () => {
    const { file, repl, insert } = setup();
    insert(50);
    expectOk(await repl.sync());
    diskFull.paths.add(restoreMarker(file));
    await expect(repl.prepareRestore({})).rejects.toThrow(/ENOSPC/);
    diskFull.paths.clear();
    expectOk(await repl.prepareRestore({}));
    expect(rows(restoreMarker(file))).toBe(50);
  });
});

describe("replication/sqlite applyPendingRestore and a restore image left half written", () => {
  it("does not apply a partly written image, removes it and keeps the live database", async () => {
    const { dir, file, app, repl, insert } = setup();
    insert(20);
    expectOk(await repl.sync());
    repl.close();
    app.close();
    open.splice(0);
    const half = fs.readFileSync(file).subarray(0, 2048);
    fs.writeFileSync(`${restoreMarker(file)}.part`, half);
    expect(applyPendingRestore(file)).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("live.db.restore"))).toEqual([]);
    expect(rows(file)).toBe(20);
  });
});
