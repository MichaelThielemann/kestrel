import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { ok } from "@michaelthielemann/kestrel/result";
import { restoreFromBlobs } from "./impl.ts";
import { referenceApplySegment, referenceRestore } from "./reference.fixture.ts";
import { applySegment, frameSize, parseFrameHeader, parseWalHeader, WAL_HEADER_SIZE } from "./wal.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-wal-"));
  dirs.push(dir);
  return dir;
}

function rowsOf(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT id, v FROM t ORDER BY id").all();
}

function opened(image: Uint8Array): { check: string; rows: unknown[] } {
  const file = join(tempDir(), "image.db");
  writeFileSync(file, image);
  const db = new DatabaseSync(file);
  try {
    return { check: boundaryCast<{ integrity_check: string }>(db.prepare("PRAGMA integrity_check").get(), "host").integrity_check, rows: rowsOf(db) };
  } finally {
    db.close();
  }
}

function capturedWal(options: { autoVacuum?: boolean; seed?: (db: DatabaseSync) => void; write: (db: DatabaseSync) => void }): { base: Uint8Array; wal: Uint8Array; rows: unknown[] } {
  const file = join(tempDir(), "live.db");
  const db = new DatabaseSync(file);
  if (options.autoVacuum) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  options.seed?.(db);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  options.write(db);
  const base = new Uint8Array(readFileSync(file));
  const wal = new Uint8Array(readFileSync(`${file}-wal`));
  const rows = rowsOf(db);
  db.close();
  return { base, wal, rows };
}

function commitsOf(wal: Uint8Array): number[] {
  const header = parseWalHeader(wal);
  if (!header) throw new Error("no WAL header");
  const size = frameSize(header.pageSize);
  const ends: number[] = [];
  for (let offset = WAL_HEADER_SIZE; offset + size <= wal.byteLength; offset += size) {
    const frame = parseFrameHeader(wal, offset);
    if (frame.salt1 !== header.salt1 || frame.salt2 !== header.salt2) break;
    if (frame.commitSize > 0) ends.push(offset + size);
  }
  return ends;
}

function insertEach(db: DatabaseSync, n: number, width: number, from = 0): void {
  const stmt = db.prepare("INSERT INTO t (v) VALUES (?)");
  for (let i = 0; i < n; i++) stmt.run(`${from + i}-`.padEnd(width, "g"));
}

describe("applySegment", () => {
  it("applies every committed frame as a plain per-commit rebuild does, through growth, shrink and regrowth", () => {
    const { base, wal, rows } = capturedWal({
      autoVacuum: true,
      seed: (db) => insertEach(db, 50, 2000),
      write: (db) => {
        insertEach(db, 300, 3000, 1000);
        db.exec("DELETE FROM t WHERE id % 4 <> 0; PRAGMA incremental_vacuum");
        insertEach(db, 120, 5000, 5000);
        db.exec("DELETE FROM t WHERE id > 300; PRAGMA incremental_vacuum");
        db.exec("BEGIN");
        insertEach(db, 40, 1500, 9000);
        db.exec("UPDATE t SET v = v || 'u' WHERE id % 3 = 0; COMMIT");
      },
    });
    const sizes = new Set(commitsOf(wal).map((end) => parseFrameHeader(wal, end - frameSize(parseWalHeader(wal)?.pageSize ?? 0)).commitSize));
    expect(sizes.size).toBeGreaterThan(3);
    const applied = applySegment(base.slice(), wal);
    expect(Buffer.from(applied).equals(Buffer.from(referenceApplySegment(base.slice(), wal)))).toBe(true);
    expect(opened(applied)).toEqual({ check: "ok", rows });
  });

  it("leaves out the frames of a transaction whose commit frame the segment does not hold", () => {
    const { base, wal } = capturedWal({ seed: (db) => insertEach(db, 20, 500), write: (db) => { for (let i = 0; i < 30; i++) insertEach(db, 3, 3000, i * 10); } });
    const ends = commitsOf(wal);
    const cut = wal.subarray(0, (ends.at(-2) ?? 0) + frameSize(parseWalHeader(wal)?.pageSize ?? 0));
    expect(Buffer.from(applySegment(base.slice(), cut)).equals(Buffer.from(referenceApplySegment(base.slice(), cut)))).toBe(true);
  });

  it("applies a segment whose commits grow the database thousands of times without copying the image for each of them", () => {
    const { base, wal, rows } = capturedWal({ seed: (db) => insertEach(db, 8000, 3800), write: (db) => insertEach(db, 3000, 3800, 100_000) });
    expect(commitsOf(wal).length).toBeGreaterThanOrEqual(3000);
    const started = performance.now();
    const applied = applySegment(base, wal);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(opened(applied)).toEqual({ check: "ok", rows });
  });
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

function segmentedReplica(base: Uint8Array, wal: Uint8Array, commitsPerSegment: number): { blobs: ReturnType<typeof memoryBlobs>; segments: number } {
  const header = wal.subarray(0, WAL_HEADER_SIZE);
  const blobs = memoryBlobs();
  const generation = "20260101T000000Z";
  blobs.blobs.set(`replica/gen/${generation}/snapshot.db`, base);
  const ends = commitsOf(wal);
  let from = WAL_HEADER_SIZE;
  let segments = 0;
  for (let i = 0; i < ends.length; i += commitsPerSegment) {
    const end = ends[Math.min(i + commitsPerSegment, ends.length) - 1] ?? from;
    const segment = new Uint8Array(WAL_HEADER_SIZE + end - from);
    segment.set(header);
    segment.set(wal.subarray(from, end), WAL_HEADER_SIZE);
    blobs.blobs.set(`replica/gen/${generation}/wal/000000-${String(segments).padStart(6, "0")}-20260101T000000Z.wal`, segment);
    segments += 1;
    from = end;
  }
  return { blobs, segments };
}

describe("restoreFromBlobs", () => {
  it("restores a generation whose segments grow and shrink the database byte for byte as the plain rebuild does", async () => {
    const { base, wal, rows } = capturedWal({
      autoVacuum: true,
      seed: (db) => insertEach(db, 200, 3000),
      write: (db) => {
        for (let i = 0; i < 40; i++) insertEach(db, 5, 3800, i * 100);
        db.exec("DELETE FROM t WHERE id % 2 = 0; PRAGMA incremental_vacuum");
        for (let i = 0; i < 40; i++) insertEach(db, 4, 2500, 10_000 + i * 100);
      },
    });
    const { blobs, segments } = segmentedReplica(base, wal, 2);
    expect(segments).toBeGreaterThan(20);
    const out = join(tempDir(), "restored.db");
    expectOk(await restoreFromBlobs(blobs, "replica/", {}, out));
    const restored = new Uint8Array(readFileSync(out));
    expect(Buffer.from(restored).equals(Buffer.from((await referenceRestore(blobs, "replica/")).image))).toBe(true);
    expect(opened(restored)).toEqual({ check: "ok", rows });
  });

  it("restores a generation whose segments keep growing the database without copying the image for each segment", async () => {
    const { base, wal, rows } = capturedWal({ seed: (db) => insertEach(db, 8000, 3800), write: (db) => insertEach(db, 1200, 3800, 100_000) });
    const { blobs, segments } = segmentedReplica(base, wal, 3);
    expect(segments).toBeGreaterThan(350);
    const out = join(tempDir(), "restored.db");
    const started = performance.now();
    expectOk(await restoreFromBlobs(blobs, "replica/", {}, out));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(opened(new Uint8Array(readFileSync(out)))).toEqual({ check: "ok", rows });
  }, 60_000);
});

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "upgrade", "5.8.1");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

function allRows(file: string): Record<string, unknown[]> {
  const copy = join(tempDir(), "rows.db");
  copyFileSync(file, copy);
  const db = new DatabaseSync(copy);
  try {
    const tables = boundaryCast<Array<{ name: string }>>(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), "host");
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

describe("restoreFromBlobs on the replica of a 5.8.1 instance", () => {
  it("rebuilds the database of the 5.8.1 fixture row for row and byte for byte as the plain rebuild does", async () => {
    const blobs = memoryBlobs();
    const root = join(FIXTURE, "blobs");
    for (const path of filesUnder(join(root, "replica"))) blobs.blobs.set(relative(root, path).split(sep).join("/"), new Uint8Array(readFileSync(path)));
    const out = join(tempDir(), "restored.db");
    expectOk(await restoreFromBlobs(blobs, "replica/", {}, out));
    const restored = new Uint8Array(readFileSync(out));
    expect(Buffer.from(restored).equals(Buffer.from((await referenceRestore(blobs, "replica/")).image))).toBe(true);
    expect(allRows(out)).toEqual(allRows(join(FIXTURE, "kestrel.db")));
  });
});
