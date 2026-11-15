import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { ok } from "@michaelthielemann/kestrel/result";
import { createReplicationSqlite, listSealedReplica, restoreFromBlobs, type Replication } from "./impl.ts";
import { parseWalHeader, WAL_HEADER_SIZE } from "./wal.ts";

const PREFIX = "replica/";

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
      const data = blobs.get(from);
      if (data !== undefined) blobs.set(to, data);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...blobs].filter(([key]) => key.startsWith(prefix)).map(([key, data]) => ({ key, size: data.byteLength })));
    },
  };
}

const dirs: string[] = [];
const opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const handle of opened.splice(0).reverse()) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database(): string {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-replication-idle-"));
  dirs.push(dir);
  const file = join(dir, "site.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT)");
  db.exec("INSERT INTO pages VALUES ('home', 'Home'), ('about', 'About')");
  db.close();
  return file;
}

function writer(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  opened.push(db);
  return db;
}

function replicate(file: string, blobs: Blobstore): Replication {
  const replication = createReplicationSqlite({ file, prefix: PREFIX, checkpointBytes: 64 * 1024 * 1024, checkpointSeconds: 3600, snapshotSeconds: 86_400, retentionSeconds: 172_800, restoreOnStart: false }, blobs, Date.now, { checkIntervalMs: 60_000 });
  opened.push(replication);
  return replication;
}

const segmentsOf = (blobs: { blobs: Map<string, Uint8Array> }, generation: string): Array<[string, Uint8Array]> => [...blobs.blobs].filter(([key]) => key.startsWith(`${PREFIX}gen/${generation}/wal/`)).sort(([a], [b]) => (a < b ? -1 : 1));

function snapshotOf(blobs: { blobs: Map<string, Uint8Array> }, generation: string): Uint8Array {
  const data = blobs.blobs.get(`${PREFIX}gen/${generation}/snapshot.db`);
  if (data === undefined) throw new Error(`generation ${generation} has no snapshot`);
  return data;
}

async function restored(blobs: Blobstore, dir: string): Promise<Uint8Array> {
  const out = join(dir, "restored.db");
  expectOk(await restoreFromBlobs(blobs, PREFIX, {}, out));
  return new Uint8Array(readFileSync(out));
}

describe("the first sync after the first snapshot of a process", () => {
  it("writes one segment without frames when nothing was committed since the snapshot, and later idle syncs write nothing", async () => {
    const file = database();
    const blobs = memoryBlobs();
    const replication = replicate(file, blobs);
    const { generation } = expectOk(await replication.sync());
    expect(segmentsOf(blobs, generation)).toEqual([]);
    expectOk(await replication.sync());
    const segments = segmentsOf(blobs, generation);
    expect(segments).toHaveLength(1);
    const [key, data] = segments[0] ?? ["", new Uint8Array()];
    expect(key).toMatch(/\/wal\/\d{6}-000000-\d{8}T\d{6}Z\.wal$/);
    expect(data.byteLength).toBe(WAL_HEADER_SIZE);
    expect(parseWalHeader(data)).not.toBeNull();
    expectOk(await replication.sync());
    expectOk(await replication.sync());
    expect(segmentsOf(blobs, generation)).toHaveLength(1);
  });

  it("writes no segment without frames when it ships frames", async () => {
    const file = database();
    const blobs = memoryBlobs();
    const replication = replicate(file, blobs);
    const { generation } = expectOk(await replication.sync());
    writer(file).exec("INSERT INTO pages VALUES ('news', 'News')");
    const shipped = expectOk(await replication.sync());
    expect(shipped.frames).toBeGreaterThan(0);
    expectOk(await replication.sync());
    const segments = segmentsOf(blobs, generation);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.[1].byteLength).toBeGreaterThan(WAL_HEADER_SIZE);
  });

  it("leaves a replica that restores byte for byte to the snapshot, and frames shipped after it apply on top", async () => {
    const file = database();
    const blobs = memoryBlobs();
    const live = writer(file);
    live.exec("PRAGMA journal_mode = WAL");
    const replication = replicate(file, blobs);
    live.exec("INSERT INTO pages VALUES ('team', 'Team')");
    const { generation } = expectOk(await replication.sync());
    expectOk(await replication.sync());
    expect(segmentsOf(blobs, generation).map(([, data]) => data.byteLength)).toEqual([WAL_HEADER_SIZE]);
    const dir = mkdtempSync(join(tmpdir(), "kestrel-replication-idle-restore-"));
    dirs.push(dir);
    expect(Buffer.from(await restored(blobs, dir)).equals(Buffer.from(snapshotOf(blobs, generation)))).toBe(true);

    live.exec("INSERT INTO pages VALUES ('news', 'News')");
    expectOk(await replication.sync());
    expect(segmentsOf(blobs, generation)).toHaveLength(2);
    const later = mkdtempSync(join(tmpdir(), "kestrel-replication-idle-later-"));
    dirs.push(later);
    await restored(blobs, later);
    const copy = new DatabaseSync(join(later, "restored.db"), { readOnly: true });
    try {
      expect(copy.prepare("SELECT id FROM pages ORDER BY id").all()).toEqual([{ id: "about" }, { id: "home" }, { id: "news" }, { id: "team" }]);
    } finally {
      copy.close();
    }
  });

  it("counts the segment in the seal, so a restore waits for it like any other", async () => {
    const file = database();
    const blobs = memoryBlobs();
    const replication = replicate(file, blobs);
    const { generation } = expectOk(await replication.sync());
    expectOk(await replication.sync());
    const seal = expectOk(await replication.seal());
    expect(seal).toMatchObject({ generation, segments: 1 });
    const listed = expectOk(await listSealedReplica(blobs, PREFIX));
    expect(listed).toMatchObject({ generation, segments: 1, missing: 0 });
  });
});
