import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { ModuleHealth } from "@michaelthielemann/kestrel/defineModule";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { logWarn, silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
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
  /** Receives the warning when another process is found writing to the same replica. Default: nothing is logged. */
  logger?: Logger;
  /**
   * A listing of the replica made before the instance was created, such as the one a start restored from: its
   * keys, and when it was made in epoch milliseconds. A key a later listing shows that this one does not counts
   * as written by another process, a WAL segment only when stamped after `at`. Default: the keys of the
   * instance's first listing, except the WAL segments stamped after the instance was created.
   */
  listedBefore?: { keys: Iterable<string>; at: number };
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

/** A file next to a generation's snapshot under `<prefix>gen/<generation>/`: `origin.json`, `applied.json` or `sealed.json`. */
export type GenerationMarker = "origin" | "applied" | "sealed";

/** What one listing of `<prefix>gen/` shows: the restore points and, per generation, the marker files next to them. */
export interface ReplicaListing {
  points: Point[];
  markers: Map<string, Set<GenerationMarker>>;
}

/** The content of `sealed.json`, written once by {@link Replication.seal} after the last frames of the generation are shipped. */
export interface Seal {
  /** The WAL lineage the replica's last frames belong to, the first number of a segment key. */
  lineage: number;
  /** How many frames of that lineage's WAL the replica holds, counted from the start of the WAL. */
  lastFrame: number;
  /** How many WAL segments the generation holds; their sequence numbers, the second number of a segment key, run from 0 to `segments - 1`. */
  segments: number;
  /** When the seal was written, in epoch milliseconds. */
  at: number;
}

/** The content of `origin.json`, written by whoever places a generation into the replica on purpose, such as a restore or an upgrade done while the process is stopped. Only `nonce` is read here. */
export interface Origin {
  /** Why the generation was placed. */
  kind: "restore" | "upgrade";
  /** What the placed database was made from, such as the id of a backup. */
  source: string;
  /** When the placement was requested, as ISO 8601. */
  requestedAt: string;
  /** A value unique to this placement, repeated in `applied.json`. */
  nonce: string;
}

/** The content of `applied.json`, written by the start that restored the database from a generation with `origin.json` and reported that restore. */
export interface Applied {
  /** The generation restored from. */
  generation: string;
  /** The `nonce` of its `origin.json`, or null when that file holds none. */
  nonce: string | null;
  /** The start of the boot that reported the restore, the value `replication.checkRestored` answers. */
  restoredAt: number;
}

export interface Replication {
  sync(): Promise<Result<{ generation: string; shippedBytes: number; frames: number; checkpointed: boolean; pruned: number }, BlobstoreError>>;
  /**
   * Ships every committed frame the replica lacks, then writes `sealed.json` into the current generation, once; a
   * later call answers the same seal. Takes no checkpoint, no periodic snapshot and prunes nothing. Without a
   * generation yet, it takes the first snapshot when the WAL holds committed frames and answers `null` without
   * writing anything when it holds none.
   */
  seal(): Promise<Result<(Seal & { generation: string }) | null, BlobstoreError>>;
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
const orderKey = (ms: number): string => ms.toString(16).padStart(12, "0");
const TIME_ONLY = /^\d{8}T\d{6}Z$/;
const generationTime = (generation: string): number => {
  const order = /^[0-9a-f]{12}/.exec(generation.slice(17))?.[0];
  const time = unstamp(generation.slice(0, 16));
  return order === undefined ? time : Math.max(time, Number.parseInt(order, 16));
};
const snapshotTime = (generation: string): number => {
  const parts = /^([0-9a-f]{12})([0-9a-f]{12})/.exec(generation.slice(17));
  const time = unstamp(generation.slice(0, 16));
  if (!parts) return time;
  const order = Number.parseInt(parts[1] ?? "", 16);
  const taken = Number.parseInt(parts[2] ?? "", 16);
  return order >= time && order < time + 1000 && taken <= order ? taken : time;
};

/** The key of a marker file of `generation`. */
export function markerKey(prefix: string, generation: string, marker: GenerationMarker): string {
  return `${prefix}gen/${generation}/${marker}.json`;
}

/**
 * The generations a start must not restore from: named by their time alone, without `origin.json`, and sorting
 * after `newest`, the newest generation that is named with an order key or carries `origin.json`. Both are empty
 * when the replica holds no generation of either kind, as a replica written only by 5.x releases does.
 */
export function unplacedNewerGenerations(listing: ReplicaListing): { newest: string | null; generations: string[] } {
  const generations = [...new Set(listing.points.filter((p) => p.kind === "snapshot").map((p) => p.generation))].sort();
  const newest = generations.filter((g) => !TIME_ONLY.test(g) || listing.markers.get(g)?.has("origin") === true).at(-1) ?? null;
  return { newest, generations: newest === null ? [] : generations.filter((g) => g > newest) };
}

/** Reads the `nonce` of a generation's `origin.json`: null when the file holds none or is not JSON, `NOT_FOUND` when the file is missing. */
export async function readOriginNonce(blobs: Blobstore, prefix: string, generation: string): Promise<Result<string | null, BlobstoreError | KestrelError<"NOT_FOUND">>> {
  const blob = await blobs.get(markerKey(prefix, generation, "origin"));
  if (isErr(blob)) return blob;
  if (blob.value === null) return err(failure("NOT_FOUND", `replication/sqlite: ${markerKey(prefix, generation, "origin")} is missing`));
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(blob.value));
    return ok(typeof parsed === "object" && parsed !== null && "nonce" in parsed && typeof parsed.nonce === "string" ? parsed.nonce : null);
  } catch {
    return ok(null);
  }
}

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

/** Rebuilds the database at `target` into `outFile`: the newest generation with a snapshot at or before `target.at` unless `target.generation` names one. `listed` takes the points of a listing already made instead of listing again. */
export async function restoreFromBlobs(blobs: Blobstore, prefix: string, target: { generation?: string; at?: number }, outFile: string, listed?: readonly Point[]): Promise<Result<{ generation: string; at: number }, KestrelError<"NOT_FOUND" | "TRANSIENT">>> {
  let points: readonly Point[];
  if (listed) points = listed;
  else {
    const fetched = await listPoints(blobs, prefix);
    if (isErr(fetched)) return fetched;
    points = fetched.value;
  }
  const until = target.at ?? Number.POSITIVE_INFINITY;
  const generation = target.generation ?? [...new Set(points.filter((p) => p.kind === "snapshot" && p.at <= until).map((p) => p.generation))].sort().at(-1);
  if (!generation) return err(failure("NOT_FOUND", "replication/sqlite: no snapshot before the requested point"));
  const snapshot = points.find((p) => p.generation === generation && p.kind === "snapshot");
  if (!snapshot) return err(failure("NOT_FOUND", `replication/sqlite: generation ${generation} has no snapshot`));
  const blob = await blobs.get(snapshot.key);
  if (isErr(blob)) return blob;
  if (blob.value === null) return err(failure("NOT_FOUND", `replication/sqlite: snapshot ${snapshot.key} is missing`));
  let image = blob.value;
  let at = snapshot.at;
  for (const p of points.filter((x) => x.generation === generation && x.kind === "wal" && x.at <= until)) {
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

const isMarker = (name: string | undefined): name is GenerationMarker => name === "origin" || name === "applied" || name === "sealed";

/** Lists `<prefix>gen/` once: every snapshot and WAL segment as a {@link Point}, and the marker files of each generation. */
export async function listReplica(blobs: Blobstore, prefix: string): Promise<Result<ReplicaListing, BlobstoreError>> {
  const list = await blobs.list(`${prefix}gen/`);
  if (isErr(list)) return list;
  const points: Point[] = [];
  const markers = new Map<string, Set<GenerationMarker>>();
  for (const info of list.value) {
    const m = /gen\/(\d{8}T\d{6}Z(?:-[0-9a-f]+)?)\/(snapshot\.db|wal\/(\d+)-(\d+)-([0-9TZ]+)\.wal|(origin|applied|sealed)\.json)$/.exec(info.key);
    if (!m) continue;
    const generation = m[1] ?? "";
    const marker = m[6];
    if (isMarker(marker)) markers.set(generation, (markers.get(generation) ?? new Set<GenerationMarker>()).add(marker));
    else if (m[2] === "snapshot.db") points.push({ generation, at: snapshotTime(generation), kind: "snapshot", key: info.key });
    else points.push({ generation, at: unstamp(m[5] ?? ""), kind: "wal", key: info.key });
  }
  points.sort((a, b) => a.generation.localeCompare(b.generation) || (a.kind === "snapshot" ? -1 : b.kind === "snapshot" ? 1 : a.key.localeCompare(b.key)));
  return ok({ points, markers });
}

/** How {@link listSealedReplica} waits for a listing that lags behind a seal. */
export interface SealedListingOptions {
  /** How many listings at most. Default 10. */
  attempts?: number;
  /** Milliseconds between two listings. Default 500. */
  delayMs?: number;
  /** Waits between two listings. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

async function readSealedSegments(blobs: Blobstore, prefix: string, generation: string): Promise<Result<number | null, BlobstoreError>> {
  const blob = await blobs.get(markerKey(prefix, generation, "sealed"));
  if (isErr(blob)) return blob;
  if (blob.value === null) return ok(null);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(blob.value));
    return ok(typeof parsed === "object" && parsed !== null && "segments" in parsed && Number.isSafeInteger(parsed.segments) && typeof parsed.segments === "number" && parsed.segments >= 0 ? parsed.segments : null);
  } catch {
    return ok(null);
  }
}

const segmentSeq = (key: string): number => Number(/\/wal\/\d+-(\d+)-[0-9TZ]+\.wal$/.exec(key)?.[1] ?? Number.NaN);

/**
 * Lists the replica, and lists it again while the listing of the newest generation with a snapshot lacks a WAL
 * segment its listed `sealed.json` names, up to `attempts` listings. `missing` is how many of the sequence numbers
 * `0` to `segments - 1` the last listing still lacks: 0 when it shows them all or when the generation has no
 * listed seal.
 */
export async function listSealedReplica(blobs: Blobstore, prefix: string, options: SealedListingOptions = {}): Promise<Result<{ listing: ReplicaListing; generation: string | null; segments: number | null; missing: number }, BlobstoreError>> {
  const attempts = Math.max(1, options.attempts ?? 10);
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seals = new Map<string, number | null>();
  for (let attempt = 1; ; attempt++) {
    const listed = await listReplica(blobs, prefix);
    if (isErr(listed)) return listed;
    const listing = listed.value;
    const generation = [...new Set(listing.points.filter((p) => p.kind === "snapshot").map((p) => p.generation))].sort().at(-1) ?? null;
    let segments: number | null = null;
    if (generation !== null && listing.markers.get(generation)?.has("sealed") === true) {
      if (!seals.has(generation)) {
        const read = await readSealedSegments(blobs, prefix, generation);
        if (isErr(read)) return read;
        seals.set(generation, read.value);
      }
      segments = seals.get(generation) ?? null;
    }
    const shown = new Set(listing.points.filter((p) => p.generation === generation && p.kind === "wal").map((p) => segmentSeq(p.key)));
    let missing = 0;
    for (let seq = 0; segments !== null && seq < segments; seq++) if (!shown.has(seq)) missing += 1;
    if (missing === 0 || attempt >= attempts) return ok({ listing, generation, segments, missing });
    await sleep(delayMs);
  }
}

async function listPoints(blobs: Blobstore, prefix: string): Promise<Result<Point[], BlobstoreError>> {
  const listing = await listReplica(blobs, prefix);
  if (isErr(listing)) return listing;
  return ok(listing.value.points);
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
  const logger = options.logger ?? silentLogger;
  const startedAt = now();
  const own = new Set<string>();
  let newestListed = 0;
  let known: Set<string> | null = options.listedBefore ? new Set(options.listedBefore.keys) : null;
  const since = options.listedBefore?.at ?? startedAt;
  let otherWriter: { key: string; seenAt: number } | null = null;
  let sealedAs: (Seal & { generation: string }) | null = null;

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

  const observe = (listing: ReplicaListing): void => {
    for (const listed of new Set([...listing.points.map((p) => p.generation), ...listing.markers.keys()])) newestListed = Math.max(newestListed, generationTime(listed));
    known ??= new Set(listing.points.filter((p) => p.kind === "snapshot" || p.at <= since).map((p) => p.key));
    if (otherWriter !== null) return;
    const baseline = known;
    const found = listing.points.find((p) => !own.has(p.generation) && !baseline.has(p.key) && listing.markers.get(p.generation)?.has("origin") !== true && (p.kind === "snapshot" || p.at > since));
    if (!found) return;
    otherWriter = { key: found.key, seenAt: now() };
    logWarn(logger, "replication/sqlite: another process writes to this replica; only one process may replicate a database to a prefix", { key: found.key, generation: found.generation });
  };

  let snapshotOrder = 0;
  const takeSnapshot = async (listed?: ReplicaListing): Promise<Result<{ generation: string; bytes: number }, BlobstoreError>> => {
    if (listed) observe(listed);
    else {
      const listing = await listReplica(blobs, config.prefix);
      if (isErr(listing)) return listing;
      observe(listing.value);
    }
    const at = now();
    let data: Uint8Array = new Uint8Array(readFileSync(file));
    const wal = readCommittedSync(fromStart);
    if (wal && wal.frames > 0) data = applySegment(data, wal.segment);
    snapshotOrder = Math.max(at, newestListed + 1, snapshotOrder + 1);
    const gen = `${stamp(snapshotOrder)}-${orderKey(snapshotOrder)}${orderKey(at)}${randomBytes(10).toString("hex")}`;
    own.add(gen);
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
    if (closed || sealedAs !== null || queued > 0 || generation === null) return;
    if (walContentBytes() < config.checkpointBytes) return;
    exclusive(maintain).catch(() => undefined);
  }, options.checkIntervalMs ?? 1000);
  timer.unref();

  const prune = async (): Promise<Result<number, BlobstoreError>> => {
    const list = await listReplica(blobs, config.prefix);
    if (isErr(list)) return list;
    observe(list.value);
    const { points, markers } = list.value;
    const generations = [...new Set([...points.map((p) => p.generation), ...markers.keys()])].sort();
    const cutoff = now() - config.retentionSeconds * 1000;
    let removed = 0;
    for (const gen of generations.slice(0, -1)) {
      const newest = Math.max(unstamp(gen.slice(0, 16)), ...points.filter((p) => p.generation === gen).map((p) => p.at));
      const successorSnapshot = generations[generations.indexOf(gen) + 1];
      if (newest >= cutoff || successorSnapshot === undefined || unstamp(successorSnapshot.slice(0, 16)) > cutoff) continue;
      const keys = [...points.filter((x) => x.generation === gen).map((p) => p.key), ...[...(markers.get(gen) ?? [])].map((marker) => markerKey(config.prefix, gen, marker))];
      for (const key of keys) {
        const removedOne = await blobs.remove(key);
        if (isErr(removedOne)) return removedOne;
        removed += 1;
      }
    }
    return ok(removed);
  };

  const runSync = async (run: { started: boolean }): Promise<Result<{ generation: string; shippedBytes: number; frames: number; checkpointed: boolean; pruned: number }, BlobstoreError>> => {
    run.started = true;
    if (generation === null) {
      const listing = await listReplica(blobs, config.prefix);
      if (isErr(listing)) return listing;
      const snap = await takeSnapshot(listing.value);
      if (isErr(snap)) return snap;
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
    seal: () =>
      exclusive(async (): Promise<Result<(Seal & { generation: string }) | null, BlobstoreError>> => {
        if (sealedAs !== null) return ok(sealedAs);
        if (generation === null) {
          const wal = readCommittedSync(fromStart);
          if (!wal || wal.frames === 0) return ok(null);
          const snap = await takeSnapshot();
          if (isErr(snap)) return snap;
        }
        const shipped = await shipNewFrames();
        if (isErr(shipped)) return shipped;
        const current = generation;
        if (current === null) throw new Error("replication/sqlite: seal ended without a generation");
        const seal: Seal = { lineage, lastFrame: cursor?.frame ?? 0, segments: seq, at: now() };
        const put = await blobs.put(markerKey(config.prefix, current, "sealed"), new TextEncoder().encode(JSON.stringify(seal)), { contentType: "application/json" });
        if (isErr(put)) return put;
        sealedAs = { generation: current, ...seal };
        return ok(sealedAs);
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
      const notes: string[] = [];
      if (restorePrepared) notes.push("replication/sqlite: a restore is prepared; restart the process to apply it");
      if (otherWriter !== null) notes.push(`replication/sqlite: another process writes to this replica (${otherWriter.key}, seen ${new Date(otherWriter.seenAt).toISOString()}); stop it, then run replication.snapshot here so the next restore starts from this process's data`);
      return notes.length === 0 ? { ok: true } : { ok: true, note: notes.join("; ") };
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
