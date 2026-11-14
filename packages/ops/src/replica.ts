import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
// eslint-disable-next-line no-restricted-imports -- kestrel-ops is a tool, not a module; it rebuilds databases with the replication package it depends on
import { markerKey, restoreFromBlobs, type Applied, type Origin, type Seal } from "@michaelthielemann/kestrel-replication-sqlite/impl";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, isErr, ok } from "@michaelthielemann/kestrel/result";
import { OpsError } from "./errors.ts";
import { hex, jsonBytes, parseJson, stamp, unstamp, type SealState } from "./layout.ts";
import { integrityCheck, sha256, sha256File, vacuumInto } from "./sqlite.ts";
import type { ObjectInfo, ObjectStore } from "./store.ts";
import type { Target, TargetStatus } from "./target.ts";

/** One replica generation as listed: its snapshot, its WAL segments and the side files next to them. */
export interface Generation {
  name: string;
  at: number;
  snapshot: ObjectInfo | null;
  segments: ObjectInfo[];
  files: Record<string, ObjectInfo>;
  /** Time of the newest segment, or of the snapshot when there is none. */
  lastFrameAt: number;
}

const GEN = /^gen\/(\d{8}T\d{6}Z(?:-[0-9a-f]+)?)\/(.+)$/;
const SEGMENT = /^wal\/\d+-(\d+)-(\d{8}T\d{6}Z)\.wal$/;

/** Generations under `prefix`, oldest first by name: the order every runtime restores by. */
export async function listGenerations(store: ObjectStore, prefix: string): Promise<Generation[]> {
  const byName = new Map<string, Generation>();
  for (const info of await store.list(`${prefix}gen/`)) {
    const m = GEN.exec(info.key.slice(prefix.length));
    if (!m) continue;
    const name = m[1] ?? "";
    const rest = m[2] ?? "";
    let gen = byName.get(name);
    if (!gen) {
      gen = { name, at: unstamp(name.slice(0, 16)), snapshot: null, segments: [], files: {}, lastFrameAt: unstamp(name.slice(0, 16)) };
      byName.set(name, gen);
    }
    const segment = SEGMENT.exec(rest);
    if (rest === "snapshot.db") gen.snapshot = info;
    else if (segment) {
      gen.segments.push(info);
      gen.lastFrameAt = Math.max(gen.lastFrameAt, unstamp(segment[2] ?? ""));
    } else gen.files[rest] = info;
  }
  return [...byName.values()].filter((g) => g.snapshot !== null).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const fingerprint = (gens: Generation[]): string => {
  const head = gens.at(-1);
  return head ? `${head.name}|${head.segments.map((s) => `${s.key}:${s.etag}`).join(",")}|${Object.keys(head.files).sort().join(",")}` : "";
};

/** Polling of a listing that may lag behind writes. */
export interface PollOptions {
  /** Consecutive identical listings needed. Default 2. */
  agree?: number;
  /** Listings at most. Default 30. */
  attempts?: number;
  /** Pause between listings in milliseconds. Default 1000. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Lists until `agree` consecutive listings show the same newest generation with the same files, and returns that listing. */
export async function stableGenerations(store: ObjectStore, prefix: string, options: PollOptions = {}): Promise<Generation[]> {
  const agree = options.agree ?? 2;
  const attempts = options.attempts ?? 30;
  const sleep = options.sleep ?? defaultSleep;
  let last = "";
  let same = 0;
  for (let i = 0; i < attempts; i++) {
    const gens = await listGenerations(store, prefix);
    const now = fingerprint(gens);
    same = now === last ? same + 1 : 1;
    last = now;
    if (same >= agree) return gens;
    await sleep(options.delayMs ?? 1000);
  }
  throw new OpsError(`the replica listing under ${prefix} did not settle after ${attempts} listings`, 1, prefix);
}

/** `blobstore@1` reads over an {@link ObjectStore}, for the replication module's own restore code. */
export function blobstoreOf(store: ObjectStore): Blobstore {
  const wrap = async <T>(what: string, run: () => Promise<T>) => {
    try {
      return ok(await run());
    } catch (cause) {
      return err(failure("TRANSIENT", `${what} failed`, { cause }));
    }
  };
  return {
    put: (key, data, options) => wrap(`put ${key}`, () => store.put(key, data, options?.contentType === undefined ? {} : { contentType: options.contentType })),
    get: (key) => wrap(`get ${key}`, () => store.get(key)),
    remove: (key) => wrap(`remove ${key}`, () => store.delete(key)),
    move: async (from, to) => {
      const copied = await wrap(`copy ${from}`, () => store.copy(from, to));
      if (isErr(copied)) return copied;
      return wrap(`remove ${from}`, () => store.delete(from));
    },
    list: (prefix) => wrap(`list ${prefix}`, async () => (await store.list(prefix)).map((i) => ({ key: i.key, size: i.size }))),
  };
}

/**
 * Rebuilds the database of `generation` from its snapshot and exactly the segments that listing shows into `outFile`,
 * which passes `quick_check`. A later listing that lags behind cannot drop a segment; a listing with a gap in its
 * segment numbers, a listed object that reads as missing and a database that fails `quick_check` are refused with an
 * {@link OpsError}. A store operation that throws, such as a timeout or an interruption, is thrown unchanged.
 */
export async function buildDatabase(store: ObjectStore, prefix: string, generation: Generation, outFile: string): Promise<{ generation: string; at: number }> {
  const gap = missingSegments(generation, numbered(generation));
  if (gap.length > 0) throw new OpsError(gapMessage(generation, gap), 1, `${prefix}gen/${generation.name}`);
  const listed = [generation.snapshot, ...generation.segments].filter((info): info is ObjectInfo => info !== null).map((info) => ({ key: info.key, size: info.size }));
  const thrown: unknown[] = [];
  const reads: ObjectStore = {
    ...store,
    get: async (key) => {
      try {
        return await store.get(key);
      } catch (cause) {
        thrown.push(cause);
        throw cause;
      }
    },
  };
  const blobs: Blobstore = { ...blobstoreOf(reads), list: async () => ok(listed) };
  const result = await restoreFromBlobs(blobs, prefix, { generation: generation.name }, outFile);
  if (thrown.length > 0) throw thrown[0];
  if (isErr(result)) throw new OpsError(`cannot rebuild generation ${generation.name}: ${result.error.message}`, 1, `${prefix}gen/${generation.name}`);
  return result.value;
}

export { markerKey };
export type { Applied, Origin, Seal };

/** The seal check of a stopped replica. */
export interface SealReport {
  state: SealState;
  generation: string;
  lastFrameAt: number;
  seal: Seal | null;
  runtime: string | null;
  /** The generation as listed; for a seal, a listing that shows every segment it counts. */
  listed: Generation;
}

/** The first major of the replication runtime that seals its replica at teardown. */
export const SEALING_MAJOR = 6;

const majorOf = (version: string | null): number | null => {
  const m = version === null ? null : /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : null;
};

function isSeal(value: unknown): value is Seal {
  if (typeof value !== "object" || value === null) return false;
  const segments: unknown = Reflect.get(value, "segments");
  return typeof Reflect.get(value, "lineage") === "number" && typeof Reflect.get(value, "lastFrame") === "number" && typeof Reflect.get(value, "at") === "number" && typeof segments === "number" && Number.isSafeInteger(segments) && segments >= 0;
}

function isApplied(value: unknown): value is Applied {
  if (typeof value !== "object" || value === null) return false;
  const nonce: unknown = Reflect.get(value, "nonce");
  return typeof Reflect.get(value, "generation") === "string" && (nonce === null || typeof nonce === "string") && typeof Reflect.get(value, "restoredAt") === "number";
}

const segmentSeq = (info: ObjectInfo): number => Number(SEGMENT.exec(info.key.slice(info.key.lastIndexOf("/wal/") + 1))?.[1]);

const missingSegments = (generation: Generation, segments: number): number[] => {
  const seen = new Set(generation.segments.map(segmentSeq));
  const missing: number[] = [];
  for (let seq = 0; seq < segments; seq++) if (!seen.has(seq)) missing.push(seq);
  return missing;
};

const numbered = (generation: Generation): number => Math.max(-1, ...generation.segments.map(segmentSeq)) + 1;

const gapMessage = (generation: Generation, missing: readonly number[]): string => `generation ${generation.name} lacks segment${missing.length > 1 ? "s" : ""} ${missing.join(", ")} of the ${numbered(generation)} its listing numbers`;

async function listUntilComplete(store: ObjectStore, prefix: string, generation: Generation, segments: (listed: Generation) => number, refuse: (missing: number[], listings: number, listed: Generation) => string, poll: PollOptions): Promise<Generation> {
  const sleep = poll.sleep ?? defaultSleep;
  let listed = generation;
  for (let i = 0; ; i++) {
    const missing = missingSegments(listed, segments(listed));
    if (missing.length === 0) return listed;
    if (i >= (poll.attempts ?? 30)) throw new OpsError(refuse(missing, i, listed), 1, `${prefix}gen/${generation.name}`);
    await sleep(poll.delayMs ?? 1000);
    listed = (await listGenerations(store, prefix)).find((g) => g.name === generation.name) ?? listed;
  }
}

/**
 * Lists `generation` again until its segment numbers run without a gap from 0 to the highest it shows, since a
 * runtime numbers them consecutively and a listing may show a later segment before an earlier one; refuses, naming
 * the missing numbers, when they do not within `poll.attempts` listings.
 */
export function completeGeneration(store: ObjectStore, prefix: string, generation: Generation, poll: PollOptions = {}): Promise<Generation> {
  return listUntilComplete(store, prefix, generation, numbered, (missing, listings, listed) => `${gapMessage(listed, missing)} after ${listings} listings`, poll);
}

async function isPlacedOnly(store: ObjectStore, prefix: string, generation: Generation): Promise<boolean> {
  if (generation.segments.length > 0) return false;
  if (generation.files["origin.json"] === undefined && (await store.get(markerKey(prefix, generation.name, "origin"))) === null) return false;
  return generation.files["applied.json"] === undefined && (await store.get(markerKey(prefix, generation.name, "applied"))) === null;
}

/**
 * Classifies the newest generation of a stopped replica. A valid `sealed.json`, read from the store whether or not
 * the listing shows it, makes it sealed whatever the runtime version; the replica is then listed again until it
 * shows every segment the seal counts, and refused when it does not within `poll.attempts` listings. Without a seal
 * it is placed when it carries `origin.json` but neither a WAL segment nor `applied.json` (no app started from it, so
 * its snapshot is the whole database); otherwise the generation is unsealed (a sealing runtime stopped without teardown), unsupported (a runtime before the sealing
 * major) or unknown (the target cannot tell the runtime version).
 */
export async function sealOf(store: ObjectStore, prefix: string, generation: Generation, runtime: string | null, poll: PollOptions = {}): Promise<SealReport> {
  const data = await store.get(markerKey(prefix, generation.name, "sealed"));
  const seal: unknown = data === null ? null : parseJsonOrNull(data);
  if (!isSeal(seal)) {
    const major = majorOf(runtime);
    const listed = await completeGeneration(store, prefix, generation, poll);
    if (await isPlacedOnly(store, prefix, listed)) return { generation: generation.name, lastFrameAt: listed.lastFrameAt, runtime, state: "placed", seal: null, listed };
    return { generation: generation.name, lastFrameAt: listed.lastFrameAt, runtime, state: major === null ? "unknown" : major < SEALING_MAJOR ? "unsupported" : "unsealed", seal: null, listed };
  }
  const listed = await listUntilComplete(store, prefix, generation, () => seal.segments, (missing, listings) => `generation ${generation.name} is sealed with ${seal.segments} segment(s), the listing shows ${seal.segments - missing.length} after ${listings} listings`, poll);
  return { generation: generation.name, lastFrameAt: listed.lastFrameAt, runtime, state: "sealed", seal, listed };
}

/** What {@link promote} needs. */
export interface PromoteInput {
  store: ObjectStore;
  prefix: string;
  target: Target;
  /** A closed database file; it is copied with `VACUUM INTO`, never uploaded as is. */
  database: string;
  origin: Omit<Origin, "nonce" | "requestedAt">;
  /** The server's time now, see `serverClock`. */
  serverNow: () => number;
  /** Local clock minus server clock in milliseconds. */
  skewMs: number;
  clock: () => number;
  poll?: PollOptions;
  /** Called with the generation's name after every check passed and before anything of it is written. */
  beforePlace?: (generation: string) => Promise<void>;
}

/** A promoted generation. */
export interface Promoted {
  generation: string;
  at: number;
  nonce: string;
  sha256: string;
  bytes: number;
}

/** The largest clock difference between this machine and the store that a promotion accepts. */
export const MAX_SKEW_MS = 30_000;

/** Throws unless the target is stopped with no running instance and `skewMs` is within {@link MAX_SKEW_MS}. */
export function checkPromotable(status: TargetStatus, skewMs: number): void {
  if (status.state !== "stopped" || status.instances > 0) throw new OpsError(`refusing to promote: the target is ${status.state} with ${status.instances} running instance(s); it must be stopped`, 1, "target");
  if (Math.abs(skewMs) > MAX_SKEW_MS) throw new OpsError(`refusing to promote: this machine's clock is ${Math.round(skewMs / 1000)} s off the store's (limit ${MAX_SKEW_MS / 1000} s)`, 1, "clock");
}

/**
 * The name a promotion gives its generation: server time rounded up to the next whole second and at least one second
 * after the newest of `existing`. Refuses when the newest generation is stamped more than {@link MAX_SKEW_MS} after
 * `serverNow`, since the app could only start once the store's time passed the new name.
 */
export function promotionName(existing: readonly Generation[], serverNow: number): { generation: string; at: number } {
  const newest = existing.at(-1);
  if (newest && newest.at - serverNow > MAX_SKEW_MS) throw new OpsError(`refusing to promote: generation ${newest.name} is stamped ${Math.round((newest.at - serverNow) / 1000)} s after the store's time (limit ${MAX_SKEW_MS / 1000} s); a runtime whose clock ran ahead wrote it`, 1, `gen/${newest.name}`);
  const floor = newest ? newest.at + 1000 : 0;
  const at = Math.ceil(Math.max(serverNow, floor) / 1000) * 1000;
  return { generation: stamp(at), at };
}

/**
 * Makes `database` the newest replica generation, so the next start of the stopped target restores it. Refuses
 * unless the target is stopped with no instance and the local clock is within {@link MAX_SKEW_MS} of the server's.
 * The generation gets the plain time name of {@link promotionName}, which every runtime lists; it is listed until it is the newest in
 * consecutive listings and read back to check its hash and integrity.
 */
export async function promote(input: PromoteInput): Promise<Promoted> {
  checkPromotable(await input.target.status(), input.skewMs);
  const existing = await stableGenerations(input.store, input.prefix, input.poll);
  const { generation, at } = promotionName(existing, input.serverNow());
  if (existing.some((g) => g.name.startsWith(generation))) throw new OpsError(`refusing to promote: generation ${generation} already exists`, 1, generation);
  const work = mkdtempSync(join(tmpdir(), "kestrel-ops-promote-"));
  try {
    const copy = join(work, "snapshot.db");
    vacuumInto(input.database, copy);
    const verdict = integrityCheck(copy);
    if (verdict !== "ok") throw new OpsError(`refusing to promote: the database fails integrity_check: ${verdict}`, 1, "db.sqlite");
    const digest = sha256File(copy);
    const bytes = new Uint8Array(readFileSync(copy));
    const origin: Origin = { ...input.origin, requestedAt: new Date(input.clock()).toISOString(), nonce: hex(16) };
    const base = `${input.prefix}gen/${generation}/`;
    await input.beforePlace?.(generation);
    await input.store.put(`${base}snapshot.db`, bytes, { contentType: "application/vnd.sqlite3" });
    await input.store.put(markerKey(input.prefix, generation, "origin"), jsonBytes(origin), { contentType: "application/json" });
    const sleep = input.poll?.sleep ?? defaultSleep;
    for (let i = 0; ; i++) {
      const gens = await stableGenerations(input.store, input.prefix, input.poll);
      if (gens.at(-1)?.name === generation && gens.at(-1)?.files["origin.json"] !== undefined) break;
      if (i >= (input.poll?.attempts ?? 30)) throw new OpsError(`promoted generation ${generation} is not the newest in the listing`, 1, generation);
      await sleep(input.poll?.delayMs ?? 1000);
    }
    const back = await input.store.get(`${base}snapshot.db`);
    if (back === null || sha256(back) !== digest) throw new OpsError(`promoted snapshot ${generation} reads back with a different hash`, 1, `${base}snapshot.db`);
    const reread = join(work, "reread.db");
    writeFileSync(reread, back);
    const reverdict = integrityCheck(reread);
    if (reverdict !== "ok") throw new OpsError(`promoted snapshot ${generation} fails integrity_check after reading it back: ${reverdict}`, 1, `${base}snapshot.db`);
    return { generation, at, nonce: origin.nonce, sha256: digest, bytes: bytes.byteLength };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Whether a runtime acknowledged a promoted generation: `applied` (an `applied.json` with its nonce), or `unconfirmed`. */
export type Acknowledgement = "applied" | "unconfirmed";

/**
 * Reads the `applied.json` a runtime writes into a promoted generation once it reported the restore, until it names
 * the generation and the nonce of its `origin.json`, or `attempts` reads found none.
 */
export async function acknowledgement(store: ObjectStore, prefix: string, promoted: Promoted, poll: PollOptions = {}): Promise<Acknowledgement> {
  const sleep = poll.sleep ?? defaultSleep;
  const key = markerKey(prefix, promoted.generation, "applied");
  for (let i = 0; i < (poll.attempts ?? 30); i++) {
    const data = await store.get(key);
    const value: unknown = data === null ? null : parseJsonOrNull(data);
    if (isApplied(value) && value.generation === promoted.generation && value.nonce === promoted.nonce) return "applied";
    await sleep(poll.delayMs ?? 1000);
  }
  return "unconfirmed";
}

function parseJsonOrNull(data: Uint8Array): unknown {
  try {
    return parseJson(data);
  } catch {
    return null;
  }
}
