import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import { applySegment, FRAME_HEADER_SIZE, frameSize, parseFrameHeader, parseWalHeader, WAL_HEADER_SIZE, type WalHeader } from "./wal.ts";

export interface Config {
  file: string;
  prefix: string;
  checkpointBytes: number;
  checkpointSeconds: number;
  snapshotSeconds: number;
  retentionSeconds: number;
  restoreOnStart: boolean;
}

export interface Point {
  generation: string;
  at: number;
  kind: "snapshot" | "wal";
  key: string;
}

export interface Status {
  generation: string | null;
  lineage: number;
  shippedFrames: number;
  lastSyncAt: number | null;
  lastSnapshotAt: number | null;
  lastCheckpointAt: number | null;
  walBytes: number;
  pendingRestore: string | null;
}

export interface Replication {
  sync(): Promise<Result<{ generation: string; shippedBytes: number; frames: number; checkpointed: boolean; pruned: number }, BlobstoreError>>;
  snapshot(): Promise<Result<{ generation: string; bytes: number }, BlobstoreError>>;
  points(): Promise<Result<Point[], BlobstoreError>>;
  prepareRestore(target: { generation?: string; at?: number }): Promise<Result<{ generation: string; at: number; file: string; restartRequired: true }, KestrelError<"NOT_FOUND" | "TRANSIENT">>>;
  status(): Promise<Status>;
  close(): void;
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const unstamp = (s: string): number => Date.parse(s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));

export function restoreMarker(file: string): string {
  return `${file}.restore`;
}

export function applyPendingRestore(file: string): boolean {
  const restored = restoreMarker(file);
  if (!existsSync(restored)) return false;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  renameSync(restored, file);
  return true;
}

export async function restoreFromBlobs(blobs: Blobstore, prefix: string, target: { generation?: string; at?: number }, outFile: string): Promise<Result<{ generation: string; at: number }, KestrelError<"NOT_FOUND" | "TRANSIENT">>> {
  const points = await listPoints(blobs, prefix);
  if (isErr(points)) return points;
  const until = target.at ?? Number.POSITIVE_INFINITY;
  const generation = target.generation ?? [...new Set(points.value.filter((p) => p.kind === "snapshot" && p.at <= until).map((p) => p.generation))].sort().at(-1);
  if (!generation) return err(failure("NOT_FOUND", "replication/sqlite: no snapshot before the requested point"));
  const snapshot = points.value.find((p) => p.generation === generation && p.kind === "snapshot");
  if (!snapshot) return err(failure("NOT_FOUND", `replication/sqlite: generation ${generation} has no snapshot`));
  const blob = await blobs.get(snapshot.key);
  if (isErr(blob)) return blob;
  if (blob.value === null) return err(failure("NOT_FOUND", `replication/sqlite: snapshot ${snapshot.key} is missing`));
  let image = blob.value.data;
  let at = snapshot.at;
  for (const p of points.value.filter((x) => x.generation === generation && x.kind === "wal" && x.at <= until)) {
    const segment = await blobs.get(p.key);
    if (isErr(segment)) return segment;
    if (segment.value === null) return err(failure("NOT_FOUND", `replication/sqlite: segment ${p.key} is missing`));
    image = applySegment(image, segment.value.data);
    at = p.at;
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, image);
  return ok({ generation, at });
}

async function listPoints(blobs: Blobstore, prefix: string): Promise<Result<Point[], BlobstoreError>> {
  const list = await blobs.list(`${prefix}gen/`);
  if (isErr(list)) return list;
  const out: Point[] = [];
  for (const info of list.value) {
    const m = /gen\/(\d{8}T\d{6}Z)\/(snapshot\.db|wal\/(\d+)-(\d+)-([0-9TZ]+)\.wal)$/.exec(info.key);
    if (!m) continue;
    const generation = m[1] as string;
    if (m[2] === "snapshot.db") out.push({ generation, at: unstamp(generation), kind: "snapshot", key: info.key });
    else out.push({ generation, at: unstamp(m[5] as string), kind: "wal", key: info.key });
  }
  return ok(out.sort((a, b) => a.generation.localeCompare(b.generation) || (a.kind === "snapshot" ? -1 : b.kind === "snapshot" ? 1 : a.key.localeCompare(b.key))));
}

export function createReplicationSqlite(config: Config, blobs: Blobstore, now: () => number = Date.now): Replication {
  const file = resolve(config.file);
  const walFile = `${file}-wal`;
  mkdirSync(dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL");
  const holdRead = (): void => {
    conn.exec("BEGIN");
    conn.prepare("SELECT count(*) FROM sqlite_master").get();
  };
  const release = (): void => {
    conn.exec("COMMIT");
  };
  holdRead();

  let generation: string | null = null;
  let lineage = 0;
  let header: WalHeader | null = null;
  let shippedFrames = 0;
  let seq = 0;
  let lastSyncAt: number | null = null;
  let lastSnapshotAt: number | null = null;
  let lastCheckpointAt: number | null = null;

  const walBytes = (): number => (existsSync(walFile) ? statSync(walFile).size : 0);
  const segmentKey = (at: number): string => `${config.prefix}gen/${generation as string}/wal/${pad(lineage, 6)}-${pad(seq, 6)}-${stamp(at)}.wal`;

  const takeSnapshot = async (): Promise<Result<{ generation: string; bytes: number }, BlobstoreError>> => {
    const at = now();
    const tmp = `${file}.snapshot-${process.pid}`;
    release();
    try {
      rmSync(tmp, { force: true });
      conn.prepare("VACUUM INTO ?").run(tmp);
    } finally {
      holdRead();
    }
    const data = new Uint8Array(readFileSync(tmp));
    rmSync(tmp, { force: true });
    const gen = stamp(at);
    const put = await blobs.put(`${config.prefix}gen/${gen}/snapshot.db`, { data, contentType: "application/vnd.sqlite3" });
    if (isErr(put)) return put;
    generation = gen;
    seq = 0;
    const current = existsSync(walFile) ? parseWalHeader(new Uint8Array(readFileSync(walFile))) : null;
    header = current;
    shippedFrames = current ? Math.floor((walBytes() - WAL_HEADER_SIZE) / frameSize(current.pageSize)) : 0;
    lastSnapshotAt = at;
    return ok({ generation: gen, bytes: data.byteLength });
  };

  // Frames written before this process took its first snapshot are covered by that snapshot; without a
  // generation there is nowhere to ship them to.
  const shipNewFrames = async (): Promise<Result<{ bytes: number; frames: number }, BlobstoreError>> => {
    if (generation === null || !existsSync(walFile)) return ok({ bytes: 0, frames: 0 });
    const wal = new Uint8Array(readFileSync(walFile));
    const current = parseWalHeader(wal);
    if (!current) return ok({ bytes: 0, frames: 0 });
    if (!header || header.salt1 !== current.salt1 || header.salt2 !== current.salt2) {
      header = current;
      lineage += 1;
      shippedFrames = 0;
    }
    const size = frameSize(current.pageSize);
    const total = Math.floor((wal.byteLength - WAL_HEADER_SIZE) / size);
    let lastCommit = -1;
    for (let i = shippedFrames; i < total; i++) {
      const frame = parseFrameHeader(wal, WAL_HEADER_SIZE + i * size);
      if (frame.salt1 !== current.salt1 || frame.salt2 !== current.salt2) break;
      if (frame.commitSize > 0) lastCommit = i;
    }
    if (lastCommit < shippedFrames) return ok({ bytes: 0, frames: 0 });
    const frames = wal.subarray(WAL_HEADER_SIZE + shippedFrames * size, WAL_HEADER_SIZE + (lastCommit + 1) * size);
    const segment = new Uint8Array(WAL_HEADER_SIZE + frames.byteLength);
    segment.set(wal.subarray(0, WAL_HEADER_SIZE));
    segment.set(frames, WAL_HEADER_SIZE);
    const put = await blobs.put(segmentKey(now()), { data: segment, contentType: "application/octet-stream" });
    if (isErr(put)) return put;
    seq += 1;
    const count = lastCommit + 1 - shippedFrames;
    shippedFrames = lastCommit + 1;
    return ok({ bytes: segment.byteLength, frames: count });
  };

  const checkpoint = (): boolean => {
    release();
    try {
      const row = conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
      const done = row !== undefined && row.busy === 0;
      if (done) {
        lastCheckpointAt = now();
        header = null;
        shippedFrames = 0;
      }
      return done;
    } finally {
      holdRead();
    }
  };

  const prune = async (): Promise<Result<number, BlobstoreError>> => {
    const list = await listPoints(blobs, config.prefix);
    if (isErr(list)) return list;
    const points = list.value;
    const generations = [...new Set(points.map((p) => p.generation))].sort();
    const cutoff = now() - config.retentionSeconds * 1000;
    let removed = 0;
    for (const gen of generations.slice(0, -1)) {
      const newest = Math.max(...points.filter((p) => p.generation === gen).map((p) => p.at));
      const successorSnapshot = generations[generations.indexOf(gen) + 1];
      if (newest >= cutoff || successorSnapshot === undefined || unstamp(successorSnapshot) > cutoff) continue;
      for (const p of points.filter((x) => x.generation === gen)) {
        const removedOne = await blobs.remove(p.key);
        if (isErr(removedOne)) return removedOne;
        removed += 1;
      }
    }
    return ok(removed);
  };

  return {
    async sync() {
      if (generation === null) {
        const existingList = await listPoints(blobs, config.prefix);
        if (isErr(existingList)) return existingList;
        const existing = existingList.value.filter((p) => p.kind === "snapshot");
        if (existing.length === 0 || lastSnapshotAt === null) {
          const snap = await takeSnapshot();
          if (isErr(snap)) return snap;
        }
      }
      const t = now();
      const shipped = await shipNewFrames();
      if (isErr(shipped)) return shipped;
      let checkpointed = false;
      const due = lastCheckpointAt === null ? t : t - lastCheckpointAt;
      if (walBytes() >= config.checkpointBytes || due >= config.checkpointSeconds * 1000) checkpointed = checkpoint();
      if (lastSnapshotAt !== null && t - lastSnapshotAt >= config.snapshotSeconds * 1000) {
        const snap = await takeSnapshot();
        if (isErr(snap)) return snap;
      }
      const pruned = await prune();
      if (isErr(pruned)) return pruned;
      lastSyncAt = t;
      return ok({ generation: generation as string, shippedBytes: shipped.value.bytes, frames: shipped.value.frames, checkpointed, pruned: pruned.value });
    },
    async snapshot() {
      const shipped = await shipNewFrames();
      if (isErr(shipped)) return shipped;
      return takeSnapshot();
    },
    points: () => listPoints(blobs, config.prefix),
    async prepareRestore(target) {
      const shipped = await shipNewFrames();
      if (isErr(shipped)) return shipped;
      const out = restoreMarker(file);
      const result = await restoreFromBlobs(blobs, config.prefix, target, out);
      if (isErr(result)) return result;
      return ok({ ...result.value, file: out, restartRequired: true as const });
    },
    async status() {
      return { generation, lineage, shippedFrames, lastSyncAt, lastSnapshotAt, lastCheckpointAt, walBytes: walBytes(), pendingRestore: existsSync(restoreMarker(file)) ? restoreMarker(file) : null };
    },
    close() {
      try {
        release();
      } catch {
        /* already released */
      }
      conn.close();
    },
  };
}

export { FRAME_HEADER_SIZE };
