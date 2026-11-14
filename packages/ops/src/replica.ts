import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
// eslint-disable-next-line no-restricted-imports -- kestrel-ops is a tool, not a module; it rebuilds databases with the replication package it depends on
import { restoreFromBlobs } from "@michaelthielemann/kestrel-replication-sqlite/impl";
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
const SEGMENT = /^wal\/\d+-\d+-(\d{8}T\d{6}Z)\.wal$/;

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
      gen.lastFrameAt = Math.max(gen.lastFrameAt, unstamp(segment[1] ?? ""));
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

/** Rebuilds the database of `generation` (snapshot plus every segment) into `outFile`, which passes `quick_check`. */
export async function buildDatabase(store: ObjectStore, prefix: string, generation: string, outFile: string): Promise<{ generation: string; at: number }> {
  const result = await restoreFromBlobs(blobstoreOf(store), prefix, { generation }, outFile);
  if (isErr(result)) throw new OpsError(`cannot rebuild generation ${generation}: ${result.error.message}`, 1, `${prefix}gen/${generation}`);
  return result.value;
}

/** `gen/<g>/sealed.json`: the teardown's proof that every frame up to `lastFrame` was shipped. */
export interface Seal {
  lineage: number;
  lastFrame: number;
  at: number;
}

/** The seal check of a stopped replica. */
export interface SealReport {
  state: SealState;
  generation: string;
  lastFrameAt: number;
  seal: Seal | null;
  runtime: string | null;
}

/** The first major of the replication runtime that seals its replica at teardown. */
export const SEALING_MAJOR = 6;

const majorOf = (version: string | null): number | null => {
  const m = version === null ? null : /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : null;
};

function isSeal(value: unknown): value is Seal {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "lastFrame") === "number" && typeof Reflect.get(value, "at") === "number";
}

/**
 * Classifies the newest generation of a stopped replica. A valid `sealed.json` makes it sealed whatever the runtime
 * version; without one it is unsealed (a sealing runtime stopped without teardown), unsupported (a runtime before the
 * sealing major) or unknown (the target cannot tell the runtime version).
 */
export async function sealOf(store: ObjectStore, prefix: string, generation: Generation, runtime: string | null): Promise<SealReport> {
  const base = { generation: generation.name, lastFrameAt: generation.lastFrameAt, runtime };
  const info = generation.files["sealed.json"];
  const data = info ? await store.get(info.key) : null;
  const seal: unknown = data === null ? null : parseJson(data);
  if (isSeal(seal)) return { ...base, state: "sealed", seal };
  const major = majorOf(runtime);
  return { ...base, state: major === null ? "unknown" : major < SEALING_MAJOR ? "unsupported" : "unsealed", seal: null };
}

/** `gen/<g>/origin.json` next to a promoted snapshot: tells a runtime that understands it that its start is a restore. */
export interface Origin {
  kind: "restore" | "upgrade";
  source: string;
  requestedAt: number;
  nonce: string;
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
 * Makes `database` the newest replica generation, so the next start of the stopped target restores it. Refuses
 * unless the target is stopped with no instance and the local clock is within {@link MAX_SKEW_MS} of the server's.
 * The generation is named by server time rounded up to the next whole second and at least one second after the
 * newest existing one, a plain time name that every runtime lists; it is listed until it is the newest in
 * consecutive listings and read back to check its hash and integrity.
 */
export async function promote(input: PromoteInput): Promise<Promoted> {
  checkPromotable(await input.target.status(), input.skewMs);
  const existing = await stableGenerations(input.store, input.prefix, input.poll);
  const newest = existing.at(-1);
  const floor = newest ? newest.at + 1000 : 0;
  const at = Math.ceil(Math.max(input.serverNow(), floor) / 1000) * 1000;
  const generation = stamp(at);
  if (existing.some((g) => g.name.startsWith(generation))) throw new OpsError(`refusing to promote: generation ${generation} already exists`, 1, generation);
  const work = mkdtempSync(join(tmpdir(), "kestrel-ops-promote-"));
  try {
    const copy = join(work, "snapshot.db");
    vacuumInto(input.database, copy);
    const verdict = integrityCheck(copy);
    if (verdict !== "ok") throw new OpsError(`refusing to promote: the database fails integrity_check: ${verdict}`, 1, "db.sqlite");
    const digest = sha256File(copy);
    const bytes = new Uint8Array(readFileSync(copy));
    const origin: Origin = { ...input.origin, requestedAt: input.clock(), nonce: hex(16) };
    const base = `${input.prefix}gen/${generation}/`;
    await input.store.put(`${base}origin.json`, jsonBytes(origin), { contentType: "application/json" });
    await input.store.put(`${base}snapshot.db`, bytes, { contentType: "application/vnd.sqlite3" });
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

/** Looks for the `applied.json` a runtime writes after restoring a promoted generation, until `attempts` listings found none. */
export async function acknowledgement(store: ObjectStore, prefix: string, promoted: Promoted, poll: PollOptions = {}): Promise<Acknowledgement> {
  const sleep = poll.sleep ?? defaultSleep;
  for (let i = 0; i < (poll.attempts ?? 30); i++) {
    for (const info of await store.list(`${prefix}gen/`)) {
      if (!info.key.endsWith("/applied.json")) continue;
      const data = await store.get(info.key);
      const value: unknown = data === null ? null : parseJson(data);
      if (typeof value === "object" && value !== null && Reflect.get(value, "nonce") === promoted.nonce) return "applied";
    }
    await sleep(poll.delayMs ?? 1000);
  }
  return "unconfirmed";
}
