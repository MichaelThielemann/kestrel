import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { ModuleHealth } from "@michaelthielemann/kestrel/defineModule";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import { applySegment, FRAME_HEADER_SIZE, FrameScanner, frameSize, parseWalHeader, WAL_HEADER_SIZE, walHeaderChecksum, type WalChecksum, type WalHeader } from "./wal.ts";

export interface Config {
  file: string;
  prefix: string;
  checkpointBytes: number;
  checkpointSeconds: number;
  snapshotSeconds: number;
  retentionSeconds: number;
  restoreOnStart: boolean;
}

/** Tuning knobs of {@link createReplicationSqlite} that are not part of the module config. */
export interface ReplicationOptions {
  /** How often the WAL size is compared with `checkpointBytes` between syncs, in milliseconds. Default 1000. */
  checkIntervalMs?: number;
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
  /** Synchronous, no I/O: reports a prepared restore informationally, since the instance keeps serving until a host restarts it to apply it. */
  health(): ModuleHealth;
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const unstamp = (s: string): number => Date.parse(s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));

export function restoreMarker(file: string): string {
  return `${file}.restore`;
}

/** Moves a database rebuilt by `prepareRestore` into place; `beforeSwap` runs before the old file is removed, while the restore can still be applied again. */
export function applyPendingRestore(file: string, beforeSwap: () => void = () => {}): boolean {
  const restored = restoreMarker(file);
  if (!existsSync(restored)) return false;
  beforeSwap();
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
  let image = blob.value;
  let at = snapshot.at;
  for (const p of points.value.filter((x) => x.generation === generation && x.kind === "wal" && x.at <= until)) {
    const segment = await blobs.get(p.key);
    if (isErr(segment)) return segment;
    if (segment.value === null) return err(failure("NOT_FOUND", `replication/sqlite: segment ${p.key} is missing`));
    image = applySegment(image, segment.value);
    at = p.at;
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, image);
  const verdict = checkImage(outFile);
  if (verdict !== "ok") {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(outFile + suffix, { force: true });
    return err(failure("TRANSIENT", `replication/sqlite: restored image of generation ${generation} (up to ${stamp(at)}) failed quick_check: ${verdict}`));
  }
  return ok({ generation, at });
}

function checkImage(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return boundaryCast<{ quick_check: string }>(db.prepare("PRAGMA quick_check").get(), "host").quick_check;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    db.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(file + suffix, { force: true });
  }
}

async function listPoints(blobs: Blobstore, prefix: string): Promise<Result<Point[], BlobstoreError>> {
  const list = await blobs.list(`${prefix}gen/`);
  if (isErr(list)) return list;
  const out: Point[] = [];
  for (const info of list.value) {
    const m = /gen\/(\d{8}T\d{6}Z(?:-[0-9a-f]+)?)\/(snapshot\.db|wal\/(\d+)-(\d+)-([0-9TZ]+)\.wal)$/.exec(info.key);
    if (!m) continue;
    const generation = m[1] ?? "";
    if (m[2] === "snapshot.db") out.push({ generation, at: unstamp(generation.slice(0, 16)), kind: "snapshot", key: info.key });
    else out.push({ generation, at: unstamp(m[5] ?? ""), kind: "wal", key: info.key });
  }
  return ok(out.sort((a, b) => a.generation.localeCompare(b.generation) || (a.kind === "snapshot" ? -1 : b.kind === "snapshot" ? 1 : a.key.localeCompare(b.key))));
}

const READ_CHUNK_BYTES = 1024 * 1024;
const SEGMENT_TARGET_BYTES = 4 * 1024 * 1024;

interface WalCursor {
  headerBytes: Uint8Array;
  header: WalHeader;
  frame: number;
  checksum: WalChecksum;
}

type WalHead = Omit<WalCursor, "frame">;

function readHead(bytes: Uint8Array, length: number): WalHead | null {
  if (length < WAL_HEADER_SIZE) return null;
  const header = parseWalHeader(bytes);
  const checksum = walHeaderChecksum(bytes);
  return header && checksum ? { headerBytes: bytes.slice(0, WAL_HEADER_SIZE), header, checksum } : null;
}

const isBusy = (e: unknown): boolean => typeof e === "object" && e !== null && "errcode" in e && typeof e.errcode === "number" && (e.errcode & 0xff) === 5;

const chunkBytes = (header: WalHeader): number => Math.max(1, Math.floor(READ_CHUNK_BYTES / frameSize(header.pageSize))) * frameSize(header.pageSize);

export function createReplicationSqlite(config: Config, blobs: Blobstore, now: () => number = Date.now, options: ReplicationOptions = {}): Replication {
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
  const writeLock = new DatabaseSync(file);
  const pageSize = boundaryCast<{ page_size: number }>(writeLock.prepare("PRAGMA page_size").get(), "host").page_size;

  let generation: string | null = null;
  let lineage = 0;
  let cursor: WalCursor | null = null;
  let seq = 0;
  let lastSyncAt: number | null = null;
  let lastSnapshotAt: number | null = null;
  let lastCheckpointAt: number | null = null;
  let restorePrepared = false;
  let closed = false;
  let pending: Array<{ key: string; data: Uint8Array }> = [];

  const walBytes = (): number => (existsSync(walFile) ? statSync(walFile).size : 0);
  const walContentBytes = (): number => {
    const row = boundaryCast<{ log: number } | undefined>(writeLock.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(), "host");
    return row === undefined || row.log <= 0 ? 0 : WAL_HEADER_SIZE + row.log * frameSize(pageSize);
  };
  const segmentKey = (currentGeneration: string, at: number): string => `${config.prefix}gen/${currentGeneration}/wal/${pad(lineage, 6)}-${pad(seq, 6)}-${stamp(at)}.wal`;

  const continueFrom = (head: WalHead): WalCursor => {
    if (!cursor || cursor.header.salt1 !== head.header.salt1 || cursor.header.salt2 !== head.header.salt2) {
      lineage += 1;
      cursor = { ...head, frame: 0 };
    }
    return cursor;
  };
  const fromStart = (head: WalHead): WalCursor => ({ ...head, frame: 0 });

  const readCommittedSync = (locate: (head: WalHead) => WalCursor): { at: WalCursor; segment: Uint8Array; frames: number; checksum: WalChecksum } | null => {
    if (!existsSync(walFile)) return null;
    const fd = openSync(walFile, "r");
    try {
      const headBytes = new Uint8Array(WAL_HEADER_SIZE);
      const head = readHead(headBytes, readSync(fd, headBytes, 0, WAL_HEADER_SIZE, 0));
      if (!head) return null;
      const at = locate(head);
      const size = frameSize(at.header.pageSize);
      const chunk = chunkBytes(at.header);
      const buffer = new Uint8Array(chunk);
      const scanner = new FrameScanner(at.header, at.checksum);
      for (let offset = WAL_HEADER_SIZE + at.frame * size; !scanner.stopped; ) {
        const read = readSync(fd, buffer, 0, chunk, offset);
        const whole = Math.floor(read / size) * size;
        scanner.push(buffer.subarray(0, whole));
        offset += whole;
        if (read < chunk) break;
      }
      return { at, ...scanner.takeSegment(at.headerBytes), checksum: scanner.checksum };
    } finally {
      closeSync(fd);
    }
  };

  const flushPending = async (): Promise<Result<void, BlobstoreError>> => {
    for (let next = pending[0]; next !== undefined; next = pending[0]) {
      const put = await blobs.put(next.key, next.data, { contentType: "application/octet-stream" });
      if (isErr(put)) return put;
      pending.shift();
    }
    return ok();
  };

  let snapshotOrder = 0;
  const takeSnapshot = async (): Promise<Result<{ generation: string; bytes: number }, BlobstoreError>> => {
    const at = now();
    let data: Uint8Array = new Uint8Array(readFileSync(file));
    const wal = readCommittedSync(fromStart);
    if (wal && wal.frames > 0) data = applySegment(data, wal.segment);
    snapshotOrder = Math.max(at, snapshotOrder + 1);
    const gen = `${stamp(at)}-${snapshotOrder.toString(16).padStart(12, "0")}${randomBytes(16).toString("hex")}`;
    const put = await blobs.put(`${config.prefix}gen/${gen}/snapshot.db`, data, { contentType: "application/vnd.sqlite3" });
    if (isErr(put)) return put;
    generation = gen;
    seq = 0;
    cursor = wal ? { ...wal.at, frame: wal.frames, checksum: wal.checksum } : null;
    pending = [];
    lastSnapshotAt = at;
    return ok({ generation: gen, bytes: data.byteLength });
  };

  const shipNewFrames = async (): Promise<Result<{ bytes: number; frames: number }, BlobstoreError>> => {
    const currentGeneration = generation;
    if (currentGeneration === null) return ok({ bytes: 0, frames: 0 });
    const flushed = await flushPending();
    if (isErr(flushed)) return flushed;
    if (!existsSync(walFile)) return ok({ bytes: 0, frames: 0 });
    const handle = await open(walFile, "r");
    try {
      const headBytes = new Uint8Array(WAL_HEADER_SIZE);
      const head = readHead(headBytes, (await handle.read(headBytes, 0, WAL_HEADER_SIZE, 0)).bytesRead);
      if (!head) return ok({ bytes: 0, frames: 0 });
      let at = continueFrom(head);
      const size = frameSize(at.header.pageSize);
      const chunk = chunkBytes(at.header);
      const buffer = new Uint8Array(chunk);
      const scanner = new FrameScanner(at.header, at.checksum);
      let bytes = 0;
      let frames = 0;
      const emit = async (): Promise<Result<void, BlobstoreError>> => {
        if (scanner.committedFrames === 0) return ok();
        const checksum = scanner.checksum;
        const taken = scanner.takeSegment(at.headerBytes);
        const put = await blobs.put(segmentKey(currentGeneration, now()), taken.segment, { contentType: "application/octet-stream" });
        if (isErr(put)) return put;
        seq += 1;
        at = { ...at, frame: at.frame + taken.frames, checksum };
        cursor = at;
        bytes += taken.segment.byteLength;
        frames += taken.frames;
        return ok();
      };
      for (let offset = WAL_HEADER_SIZE + at.frame * size; !scanner.stopped; ) {
        const { bytesRead } = await handle.read(buffer, 0, chunk, offset);
        const whole = Math.floor(bytesRead / size) * size;
        scanner.push(buffer.subarray(0, whole));
        offset += whole;
        if (scanner.committedBytes >= SEGMENT_TARGET_BYTES) {
          const emitted = await emit();
          if (isErr(emitted)) return emitted;
        }
        if (bytesRead < chunk) break;
      }
      const emitted = await emit();
      if (isErr(emitted)) return emitted;
      return ok({ bytes, frames });
    } finally {
      await handle.close();
    }
  };

  const checkpoint = async (): Promise<Result<{ done: boolean; bytes: number; frames: number }, BlobstoreError>> => {
    const currentGeneration = generation;
    if (currentGeneration === null) return ok({ done: false, bytes: 0, frames: 0 });
    try {
      writeLock.exec("BEGIN IMMEDIATE");
    } catch (e) {
      if (isBusy(e)) return ok({ done: false, bytes: 0, frames: 0 });
      throw e;
    }
    let tail: ReturnType<typeof readCommittedSync>;
    let done: boolean;
    try {
      tail = readCommittedSync(continueFrom);
      release();
      try {
        const row = boundaryCast<{ busy: number; log: number; checkpointed: number } | undefined>(conn.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(), "host");
        done = row !== undefined && row.busy === 0 && row.log === row.checkpointed;
      } finally {
        holdRead();
      }
    } finally {
      writeLock.exec("ROLLBACK");
    }
    if (tail) {
      if (tail.frames > 0) {
        pending.push({ key: segmentKey(currentGeneration, now()), data: tail.segment });
        seq += 1;
      }
      cursor = { ...tail.at, frame: tail.at.frame + tail.frames, checksum: tail.checksum };
    }
    if (done) lastCheckpointAt = now();
    const flushed = await flushPending();
    if (isErr(flushed)) return flushed;
    return ok({ done, bytes: tail && tail.frames > 0 ? tail.segment.byteLength : 0, frames: tail?.frames ?? 0 });
  };

  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    queued += 1;
    const run = queue.then(task).finally(() => {
      queued -= 1;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const maintain = async (): Promise<void> => {
    if (closed) return;
    const shipped = await shipNewFrames();
    if (isErr(shipped) || closed) return;
    await checkpoint();
  };
  const timer = setInterval(() => {
    if (closed || queued > 0 || generation === null) return;
    if (walContentBytes() < config.checkpointBytes) return;
    exclusive(maintain).catch(() => undefined);
  }, options.checkIntervalMs ?? 1000);
  timer.unref();

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
      if (newest >= cutoff || successorSnapshot === undefined || unstamp(successorSnapshot.slice(0, 16)) > cutoff) continue;
      for (const p of points.filter((x) => x.generation === gen)) {
        const removedOne = await blobs.remove(p.key);
        if (isErr(removedOne)) return removedOne;
        removed += 1;
      }
    }
    return ok(removed);
  };

  const runSync = async (run: { started: boolean }): Promise<Result<{ generation: string; shippedBytes: number; frames: number; checkpointed: boolean; pruned: number }, BlobstoreError>> => {
    run.started = true;
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
    let shippedBytes = shipped.value.bytes;
    let frames = shipped.value.frames;
    let checkpointed = false;
    const due = lastCheckpointAt === null ? t : t - lastCheckpointAt;
    if (walContentBytes() >= config.checkpointBytes || due >= config.checkpointSeconds * 1000) {
      const result = await checkpoint();
      if (isErr(result)) return result;
      checkpointed = result.value.done;
      shippedBytes += result.value.bytes;
      frames += result.value.frames;
    }
    if (lastSnapshotAt !== null && t - lastSnapshotAt >= config.snapshotSeconds * 1000) {
      const snap = await takeSnapshot();
      if (isErr(snap)) return snap;
    }
    const pruned = await prune();
    if (isErr(pruned)) return pruned;
    lastSyncAt = t;
    if (generation === null) throw new Error("replication/sqlite: sync ended without a generation");
    return ok({ generation, shippedBytes, frames, checkpointed, pruned: pruned.value });
  };
  let current: { run: { started: boolean }; result: ReturnType<typeof runSync> } | null = null;
  let followUp: ReturnType<typeof runSync> | null = null;
  const startSync = (): ReturnType<typeof runSync> => {
    const run = { started: false };
    const result = exclusive(() => runSync(run)).finally(() => {
      if (current?.run === run) current = null;
    });
    current = { run, result };
    return result;
  };

  return {
    sync() {
      if (current && !current.run.started) return current.result;
      if (followUp) return followUp;
      if (!current) return startSync();
      const next = current.result.catch(() => undefined).then(() => {
        followUp = null;
        return startSync();
      });
      followUp = next;
      return next;
    },
    snapshot: () =>
      exclusive(async () => {
        const shipped = await shipNewFrames();
        if (isErr(shipped)) return shipped;
        return takeSnapshot();
      }),
    points: () => listPoints(blobs, config.prefix),
    prepareRestore: (target) =>
      exclusive(async () => {
        const shipped = await shipNewFrames();
        if (isErr(shipped)) return shipped;
        const out = restoreMarker(file);
        const result = await restoreFromBlobs(blobs, config.prefix, target, out);
        if (isErr(result)) return result;
        restorePrepared = true;
        return ok({ ...result.value, file: out, restartRequired: true as const });
      }),
    async status() {
      return { generation, lineage, shippedFrames: cursor?.frame ?? 0, lastSyncAt, lastSnapshotAt, lastCheckpointAt, walBytes: walBytes(), pendingRestore: existsSync(restoreMarker(file)) ? restoreMarker(file) : null };
    },
    health(): ModuleHealth {
      if (!restorePrepared) return { ok: true };
      return { ok: true, note: "replication/sqlite: a restore is prepared; restart the process to apply it" };
    },
    close() {
      closed = true;
      clearInterval(timer);
      try {
        release();
        // eslint-disable-next-line no-empty -- release() on an already released lock throws; nothing is left to do
      } catch {
      }
      conn.close();
      writeLock.close();
    },
  };
}

export { FRAME_HEADER_SIZE };
