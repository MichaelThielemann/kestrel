import { statSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { messageOf, REPLICATION_PACKAGE, runtimeVersion, startTarget, stopTarget, type OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";
import { fixedLines, fixedText, literal } from "./redact.ts";
import { openRuns, listRuns, RUN_STALE_MS } from "./journal.ts";
import { Interrupted } from "./interrupt.ts";
import { heldLocks } from "./lock.ts";
import { BACKUP_KINDS, backupId, fromJsonl, jsonBytes, keys, parseBackupId, parseJson, parseJsonOrNull, stamp, toJsonl, type BackupKind, type BlobEntry, type DerivedEntry, type Manifest, type SiteEntry } from "./layout.ts";
import { placedUnstarted, refuseUnfinishedPlacement } from "./placements.ts";
import { confirm } from "./questions.ts";
import { buildDatabase, completeGeneration, SEALING_MAJOR, sealOf, stableGenerations, type SealReport } from "./replica.ts";
import { UPDATE_PIN_PREFIX } from "./update/layout.ts";
import { integrityCheck, referencedBlobs, sha256, sha256File, tableCounts, vacuumInto } from "./sqlite.ts";
import { ObjectMissing, PreconditionFailed, listMap, stableList, transfer, type ObjectInfo, type ObjectStore } from "./store.ts";

/**
 * How a backup gets its database: from the replica of a running app, after stopping it, or from a stop the caller
 * already made. `unreadable` is a stop whose replica cannot be read: the backup holds every original under the media
 * prefix and the delivery keys, but no database.
 */
export type BackupMode = { kind: "live" } | { kind: "freeze" } | { kind: "stopped"; seal: SealReport; stoppedAt: number } | { kind: "unreadable"; reason: string; stoppedAt: number };

/** Options of {@link createBackup}. */
export interface BackupOptions {
  kind: BackupKind;
  mode: BackupMode;
  /** Pin the backup for this run, so prune keeps it until the run has ended. */
  pinFor?: string;
  /** Versions the manifest records in place of the project's and the target's, such as the running versions an update knows. */
  versions?: Record<string, string>;
  /** The Kestrel major that wrote the backed-up data, recorded when the versions do not name it. */
  major?: number;
}

/** A written and verified backup. */
export interface BackupResult {
  id: string;
  manifest: Manifest;
  verification: Verification;
}

const COPY_ATTEMPTS = 3;

/** Asks for the `unsealed-stop` answer when a stopped replica carries no seal, showing the evidence the target has. */
export async function acceptSeal(ctx: OpsContext, seal: SealReport, stoppedAt: number): Promise<void> {
  if (seal.state === "sealed") return;
  if (seal.state === "placed") {
    ctx.out.info(`generation ${seal.generation} is a complete placement of an earlier restore that no app started from yet; its snapshot is the whole database`);
    return;
  }
  const evidence = (await ctx.target.stopEvidence?.()) ?? [];
  const lastFrame = new Date(seal.lastFrameAt).toISOString();
  const lines = [
    seal.state === "unsupported"
      ? fixedText`seal unsupported (runtime ${seal.runtime ?? fixedText`before ${SEALING_MAJOR}`}): the replica cannot prove the stop shipped every frame`
      : seal.state === "unknown"
        ? fixedText`seal unknown: generation ${literal(seal.generation)} has no seal and the running replication runtime version is unknown; a runtime before ${SEALING_MAJOR} writes none, a later one stopped without teardown`
        : fixedText`unsealed: generation ${literal(seal.generation)} has no seal; the stop went without teardown`,
    fixedText`last shipped segment ${literal(lastFrame)}, stopped ${literal(new Date(stoppedAt).toISOString())}`,
    ...evidence,
  ];
  for (const line of lines) ctx.out.warn(line);
  await confirm(ctx.answers, "unsealed-stop", fixedLines(lines));
}

/**
 * Reads the newest generation of the stopped replica and classifies its seal, for the replication runtime version
 * `runtime` (null when it is unknown), or by default the one the target reports.
 */
export async function readSeal(ctx: OpsContext, runtime?: string | null): Promise<SealReport> {
  const gens = await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll);
  const newest = gens.at(-1);
  if (!newest) throw new OpsError(`the replica under ${ctx.env.app.replicaPrefix} has no generation`, 1, ctx.env.app.replicaPrefix);
  await refuseUnfinishedPlacement(ctx, gens);
  const known = runtime === undefined ? runtimeVersion(await ctx.target.describe()) : runtime;
  return sealOf(ctx.app, ctx.env.app.replicaPrefix, newest, known, ctx.poll, (generation) => placedUnstarted(ctx, generation));
}

type CopiedEntry = { key: string; size: number; etag: string; object: string; objectEtag: string };

async function copyIntoObjects(ctx: OpsContext, info: ObjectInfo, existing: Map<string, ObjectInfo>, checksum: string | null = null, mismatch?: (found: string) => void): Promise<{ entry: CopiedEntry; copied: boolean } | null> {
  let current: ObjectInfo | null = info;
  for (let attempt = 0; attempt < COPY_ATTEMPTS && current !== null; attempt++) {
    const source: ObjectInfo = current;
    const objectKey = keys.object(source.key, source.etag);
    const object = ctx.location + objectKey;
    const entry = (objectEtag: string): CopiedEntry => ({ key: source.key, size: source.size, etag: source.etag, object: objectKey, objectEtag });
    const known = existing.get(object) ?? (await ctx.backups.head(object));
    if (known && known.size === source.size) return { entry: entry(known.etag), copied: false };
    if (known) throw new OpsError(`${objectKey} holds ${known.size} bytes where ${source.key} has ${source.size}: the backup copy is damaged, and a key of the backup location is never overwritten; verify the backups that list it, then remove it so the next backup copies it again`, 1, objectKey);
    let streamed: Uint8Array | null;
    try {
      streamed = await transfer(ctx.app, source.key, ctx.backups, object, source.etag);
    } catch (cause) {
      if (cause instanceof ObjectMissing) return null;
      if (!(cause instanceof PreconditionFailed)) throw cause;
      current = await ctx.app.head(source.key);
      continue;
    }
    const written = await ctx.backups.head(object);
    const now = written !== null && written.size === source.size && streamed === null && written.etag !== source.etag ? await ctx.app.head(source.key) : source;
    if (written !== null && written.size === source.size && now !== null && now.etag === source.etag) {
      if (streamed !== null && checksum !== null && sha256(streamed) !== checksum) {
        if (mismatch === undefined) throw new OpsError(`the copy of ${source.key} does not hash to the checksum of its media row`, 1, source.key);
        mismatch(sha256(streamed));
      }
      existing.set(object, written);
      return { entry: entry(written.etag), copied: true };
    }
    await ctx.backups.delete(object);
    current = now === source ? await ctx.app.head(source.key) : now;
  }
  if (current === null) return null;
  throw new OpsError(`${info.key} kept changing while it was copied`, 1, info.key);
}

/** Copies every key the app lists under `prefixes` into `objects/`, skipping what is already there; run before a stop to keep the frozen phase short. */
export async function precopy(ctx: OpsContext, prefixes: readonly string[]): Promise<number> {
  const existing = await listMap(ctx.backups, `${ctx.location}objects/`);
  let copied = 0;
  for (const prefix of prefixes) for (const info of await ctx.app.list(prefix)) if ((await copyIntoObjects(ctx, info, existing))?.copied) copied += 1;
  return copied;
}

async function putNew(store: ObjectStore, key: string, data: Uint8Array, contentType: string): Promise<void> {
  if ((await store.head(key)) !== null) throw new OpsError(`refusing to overwrite ${key}`, 1, key);
  await store.put(key, data, { contentType });
}

/** Writes a backup of the environment's current state and verifies it. A frozen backup stops the app and starts it again afterwards, also when the backup fails. */
export async function createBackup(ctx: OpsContext, options: BackupOptions): Promise<BackupResult> {
  if (options.mode.kind !== "freeze") return writeBackup(ctx, options, options.mode);
  const pre = await precopy(ctx, [ctx.env.app.mediaPrefix, ctx.env.app.deliveryPrefix]);
  ctx.out.info(`precopied ${pre} object(s) while the app runs`);
  const stop = await stopTarget(ctx);
  let result: BackupResult;
  try {
    const seal = await readSeal(ctx);
    await acceptSeal(ctx, seal, stop.stoppedAt);
    result = await writeBackup(ctx, options, { kind: "stopped", seal, stoppedAt: stop.stoppedAt });
  } catch (error) {
    if (stop.wasRunning) await startTarget(ctx).catch((cause: unknown) => ctx.out.error(`starting the app again failed: ${messageOf(cause)}`));
    throw error;
  }
  if (stop.wasRunning) {
    try {
      await startTarget(ctx);
    } catch (cause) {
      throw new OpsError(`backup ${result.id} is written and verified, but starting the app again failed: ${messageOf(cause)}`, 1, "target", result.id);
    }
  }
  return result;
}

async function writeBackup(ctx: OpsContext, options: BackupOptions, mode: Exclude<BackupMode, { kind: "freeze" }>): Promise<BackupResult> {
  const id = backupId(ctx.envName, ctx.clock(), options.kind);
  const { app } = ctx.env;
  await ctx.journal.record("backup", "started", { backupId: id, kind: options.kind, mode: mode.kind });
  if (options.pinFor !== undefined) await ctx.backups.put(ctx.location + keys.pin(id, options.pinFor), jsonBytes({ runId: options.pinFor, at: ctx.clock() }), { contentType: "application/json" });
  const facts = await ctx.target.describe();
  let seal: SealReport | null = null;
  if (mode.kind === "stopped") {
    seal = mode.seal;
  } else if (mode.kind === "live") {
    const gens = await stableGenerations(ctx.app, app.replicaPrefix, ctx.poll);
    const newest = gens.at(-1);
    if (!newest) throw new OpsError(`the replica under ${app.replicaPrefix} has no generation`, 1, app.replicaPrefix);
    await refuseUnfinishedPlacement(ctx, gens);
    const listed = await completeGeneration(ctx.app, app.replicaPrefix, newest, ctx.poll);
    seal = { state: "live", generation: newest.name, lastFrameAt: listed.lastFrameAt, seal: null, runtime: runtimeVersion(facts), listed };
  }
  let dbFile: string | null = null;
  let db: Manifest["db"] = null;
  if (seal !== null) {
    const built = ctx.workspace.path(`${id}.source.db`);
    await buildDatabase(ctx.app, app.replicaPrefix, seal.listed, built);
    dbFile = ctx.workspace.path(`${id}.db`);
    vacuumInto(built, dbFile);
    const integrity = integrityCheck(dbFile);
    if (integrity !== "ok") throw new OpsError(`the database rebuilt from generation ${seal.generation} fails integrity_check: ${integrity}`, 1, "db.sqlite");
    db = { bytes: statSync(dbFile).size, sha256: sha256File(dbFile), integrity, rows: tableCounts(dbFile) };
  }

  const existing = await listMap(ctx.backups, `${ctx.location}objects/`);
  const live = await listMap(ctx.app, app.mediaPrefix);
  const blobs: BlobEntry[] = [];
  const missing: string[] = [];
  const mismatched = new Map<string, string>();
  const keepMismatch = options.kind === "pre-restore";
  const refs = dbFile === null ? [...live.keys()].map((key) => ({ key, sha256: null })) : referencedBlobs(dbFile, app.media);
  for (const ref of refs) {
    const info = live.get(ref.key) ?? (await ctx.app.head(ref.key));
    const copied = info === null ? null : await copyIntoObjects(ctx, info, existing, ref.sha256, keepMismatch ? (found) => mismatched.set(ref.key, found) : undefined);
    if (copied === null) missing.push(ref.key);
    else blobs.push({ ...copied.entry, sha256: ref.sha256 });
  }
  if (keepMismatch) {
    for (const entry of sampledOriginals(blobs)) {
      if (mismatched.has(entry.key)) continue;
      const bytes = await ctx.backups.get(ctx.location + entry.object);
      if (bytes !== null && sha256(bytes) !== entry.sha256) mismatched.set(entry.key, sha256(bytes));
    }
  }
  const site: SiteEntry[] = [];
  for (const info of await stableList(ctx.app, app.deliveryPrefix, ctx.poll)) {
    const copied = await copyIntoObjects(ctx, info, existing);
    if (copied !== null) site.push(copied.entry);
  }
  const derived: DerivedEntry[] = [];
  const derivedTotals: Manifest["derived"] = {};
  for (const prefix of app.derivedPrefixes) {
    const listed = await ctx.app.list(prefix);
    derivedTotals[prefix] = { count: listed.length, bytes: listed.reduce((n, i) => n + i.size, 0) };
    for (const info of listed) derived.push({ key: info.key, size: info.size, etag: info.etag });
  }

  if (dbFile !== null) await putNew(ctx.backups, ctx.location + keys.db(id), new Uint8Array(readFileSync(dbFile)), "application/vnd.sqlite3");
  await putNew(ctx.backups, ctx.location + keys.blobs(id), toJsonl(blobs), "application/x-ndjson");
  await putNew(ctx.backups, ctx.location + keys.site(id), toJsonl(site), "application/x-ndjson");
  await putNew(ctx.backups, ctx.location + keys.derived(id), toJsonl(derived), "application/x-ndjson");
  await recordRecent(ctx, id);
  const manifest: Manifest = {
    schema: "kestrel-ops/backup@1",
    id,
    env: ctx.envName,
    kind: options.kind,
    createdAt: ctx.clock(),
    frozen: mode.kind !== "live",
    tool: ctx.tool,
    source: seal === null ? { generation: null, lastFrameAt: null, seal: "unreadable", sealAt: null } : { generation: seal.generation, lastFrameAt: seal.lastFrameAt, seal: seal.state, sealAt: seal.seal?.at ?? null },
    versions: options.versions ?? { ...ctx.project.versions, ...facts.packages },
    ...(options.major === undefined ? {} : { major: options.major }),
    node: process.version,
    lockfileSha256: ctx.project.lockfileSha256,
    db,
    blobs: { count: blobs.length, bytes: blobs.reduce((n, b) => n + b.size, 0), missingAtBackup: missing, mismatchAtBackup: [...mismatched].map(([key, found]) => ({ key, sha256: found })) },
    site: { prefix: app.deliveryPrefix, count: site.length, bytes: site.reduce((n, s) => n + s.size, 0), pathsSha256: sha256(site.map((s) => s.key).join("\n")) },
    derived: derivedTotals,
    target: facts,
  };
  await putNew(ctx.backups, ctx.location + keys.manifest(id), new TextEncoder().encode(ctx.redactor.document(manifest, 2) + "\n"), "application/json");
  for (const key of missing) ctx.out.warn(`original ${key} is referenced by a media row but missing in the store`);
  for (const key of mismatched.keys()) ctx.out.warn(`original ${key} does not hash to the checksum of its media row; the ${options.kind} backup keeps it as the store holds it`);
  const verification = await verifyBackup(ctx, id);
  await ctx.journal.record("backup", verification.ok ? "done" : "failed", { backupId: id, problems: verification.problems });
  if (!verification.ok) throw new OpsError(`backup ${id} failed verification: ${verification.problems.map((p) => `${p.element}: ${p.message}`).join("; ")}`, 1, verification.problems[0]?.element);
  return { id, manifest, verification };
}

/** One problem verification found, with the backup part or key it concerns. */
export interface Problem {
  element: string;
  message: string;
}

/** The outcome of {@link verifyBackup}, also written to `backups/<id>/verify/`. */
export interface Verification {
  id: string;
  at: number;
  ok: boolean;
  checked: { tables: number; blobs: number; site: number; sampled: number };
  problems: Problem[];
}

function isManifest(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && Reflect.get(value, "schema") === "kestrel-ops/backup@1";
}

/** Reads a backup's manifest; null when it has none (an incomplete backup). */
export async function readManifest(ctx: Pick<OpsContext, "backups" | "location">, id: string): Promise<Manifest | null> {
  const data = await ctx.backups.get(ctx.location + keys.manifest(id));
  if (data === null) return null;
  let value: unknown;
  try {
    value = parseJson(data);
  } catch (cause) {
    throw new OpsError(`backup ${id}: manifest.json is no valid JSON: ${messageOf(cause)}`, 1, "manifest.json");
  }
  if (!isManifest(value)) throw new OpsError(`backup ${id}: manifest.json has an unknown format`, 1, "manifest.json");
  return value;
}

type JsonLines<T> = { entries: T[] } | { missing: true } | { unreadable: string };

async function readJsonl<T>(ctx: OpsContext, key: string): Promise<JsonLines<T>> {
  const data = await ctx.backups.get(key);
  if (data === null) return { missing: true };
  try {
    return { entries: boundaryCast<T[]>(fromJsonl(data), "json") };
  } catch (cause) {
    return { unreadable: `no valid JSON lines: ${messageOf(cause)}` };
  }
}

const problemOf = (list: JsonLines<unknown>): string | null => ("missing" in list ? "missing" : "unreadable" in list ? list.unreadable : null);

/** How many originals verification hashes: 25 or 2 %, whichever is more, at most 200. */
export function sampleSize(total: number): number {
  return Math.min(total, Math.min(200, Math.max(25, Math.ceil(total * 0.02))));
}

function sampledOriginals<T extends { sha256: string | null }>(entries: readonly T[]): Array<T & { sha256: string }> {
  const hashed = entries.filter((entry): entry is T & { sha256: string } => entry.sha256 !== null);
  const step = hashed.length / Math.max(1, sampleSize(hashed.length));
  const out: Array<T & { sha256: string }> = [];
  for (let i = 0; i < sampleSize(hashed.length); i++) {
    const entry = hashed[Math.floor(i * step)];
    if (entry) out.push(entry);
  }
  return out;
}

/** How a `blobs.jsonl` or `site.jsonl` whose length differs from its manifest's count is named. */
export function entryCountMismatch(entries: number, count: number): string {
  return `holds ${entries} ${entries === 1 ? "entry" : "entries"}, the manifest counts ${count}`;
}

function countedEntries(manifest: Manifest | null, part: "blobs" | "site"): number | null {
  const section: unknown = manifest === null ? undefined : Reflect.get(manifest, part);
  const count: unknown = typeof section === "object" && section !== null ? Reflect.get(section, "count") : undefined;
  return typeof count === "number" ? count : null;
}

/**
 * Verifies a backup from what the backup location holds: the database (when the backup has one) is read back, hashed and fully
 * integrity-checked, its rows are counted against the manifest, `blobs.jsonl` and `site.jsonl` hold as many entries as
 * the manifest counts and the delivery keys hash to its `pathsSha256`, every referenced original and every delivery key
 * has its entry and an object of the recorded size, and a sample of originals hashes to the checksum of its row. An
 * object the listing does not show yet is looked up by a HEAD before it counts as missing.
 */
export async function verifyBackup(ctx: OpsContext, id: string): Promise<Verification> {
  const problems: Problem[] = [];
  const checked = { tables: 0, blobs: 0, site: 0, sampled: 0 };
  const finish = async (): Promise<Verification> => {
    const result: Verification = { id, at: ctx.clock(), ok: problems.length === 0, checked, problems };
    await ctx.backups.put(ctx.location + keys.verification(id, result.at), new TextEncoder().encode(ctx.redactor.document(result, 2) + "\n"), { contentType: "application/json" });
    return result;
  };
  let manifest: Manifest | null;
  try {
    manifest = await readManifest(ctx, id);
  } catch (cause) {
    if (!(cause instanceof OpsError) || cause.element !== "manifest.json") throw cause;
    problems.push({ element: "manifest.json", message: cause.message });
    return finish();
  }
  if (manifest === null) {
    if ((await ctx.backups.list(ctx.location + keys.backupDir(id))).length === 0) return { id, at: ctx.clock(), ok: false, checked, problems: [{ element: "manifest.json", message: `backup ${id} does not exist` }] };
    problems.push({ element: "manifest.json", message: `backup ${id} has no manifest` });
    return finish();
  }
  let file: string | null = null;
  if (manifest.db !== null) {
    const data = await ctx.backups.get(ctx.location + keys.db(id));
    if (data === null) problems.push({ element: "db.sqlite", message: "missing" });
    else if (sha256(data) !== manifest.db.sha256) problems.push({ element: "db.sqlite", message: `sha256 ${sha256(data).slice(0, 12)}… differs from the manifest's ${manifest.db.sha256.slice(0, 12)}… (${data.byteLength} of ${manifest.db.bytes} bytes)` });
    if (problems.length > 0) return finish();
    file = ctx.workspace.path(`${id}.verify.db`);
    writeFileSync(file, data ?? new Uint8Array());
    const integrity = integrityCheck(file);
    if (integrity !== "ok") {
      problems.push({ element: "db.sqlite", message: `integrity_check: ${integrity}` });
      file = null;
    } else {
      const rows = tableCounts(file);
      for (const [table, n] of Object.entries(manifest.db.rows)) {
        checked.tables += 1;
        if (rows[table] !== n) problems.push({ element: `db.sqlite:${table}`, message: `${rows[table] ?? 0} rows, the manifest says ${n}` });
      }
    }
  }
  const objects = await listMap(ctx.backups, `${ctx.location}objects/`);
  const blobList = await readJsonl<BlobEntry>(ctx, ctx.location + keys.blobs(id));
  const siteList = await readJsonl<SiteEntry>(ctx, ctx.location + keys.site(id));
  for (const [list, element] of [[blobList, "blobs.jsonl"], [siteList, "site.jsonl"]] as const) {
    const problem = problemOf(list);
    if (problem !== null) problems.push({ element, message: problem });
  }
  const blobs = "entries" in blobList ? blobList.entries : null;
  const site = "entries" in siteList ? siteList.entries : null;
  if (blobs !== null && blobs.length !== manifest.blobs.count) problems.push({ element: "blobs.jsonl", message: entryCountMismatch(blobs.length, manifest.blobs.count) });
  if (site !== null && site.length !== manifest.site.count) problems.push({ element: "site.jsonl", message: entryCountMismatch(site.length, manifest.site.count) });
  else if (site !== null && sha256(site.map((s) => s.key).join("\n")) !== manifest.site.pathsSha256) problems.push({ element: "site.jsonl", message: "its keys do not hash to the manifest's pathsSha256" });
  if (blobs !== null && file !== null) {
    const byKey = new Map(blobs.map((b) => [b.key, b]));
    for (const ref of referencedBlobs(file, ctx.env.app.media)) {
      if (manifest.blobs.missingAtBackup.includes(ref.key)) continue;
      if (!byKey.has(ref.key)) problems.push({ element: ref.key, message: "referenced by a media row but not in blobs.jsonl" });
    }
  }
  for (const [list, kind] of [[blobs ?? [], "blobs"], [site ?? [], "site"]] as const) {
    for (const entry of list) {
      checked[kind] += 1;
      const key = ctx.location + entry.object;
      const object = objects.get(key) ?? (await ctx.backups.head(key));
      if (object) objects.set(key, object);
      if (!object) problems.push({ element: entry.key, message: `backup object ${entry.object} is missing` });
      else if (object.size !== entry.size) problems.push({ element: entry.key, message: `backup object ${entry.object} has ${object.size} bytes, expected ${entry.size}` });
    }
  }
  const recorded = new Map((manifest.blobs.mismatchAtBackup ?? []).map((m) => [m.key, m.sha256]));
  for (const entry of sampledOriginals((blobs ?? []).filter((b) => objects.has(ctx.location + b.object)))) {
    checked.sampled += 1;
    const bytes = await ctx.backups.get(ctx.location + entry.object);
    const digest = bytes === null ? null : sha256(bytes);
    if (digest === null || (digest !== entry.sha256 && digest !== recorded.get(entry.key))) problems.push({ element: entry.key, message: `backup object ${entry.object} does not hash to the checksum of its media row` });
  }
  return finish();
}

/** A backup as the backup location lists it. */
export interface BackupSummary {
  id: string;
  kind: BackupKind;
  at: number;
  complete: boolean;
  verified: boolean | null;
  pinnedBy: string[];
  newestWrite: number;
}

/** Every backup of the environment, oldest first. */
export async function listBackups(ctx: Pick<OpsContext, "backups" | "location" | "envName">): Promise<BackupSummary[]> {
  const byId = new Map<string, BackupSummary & { verifyKeys: string[]; verifyStamp: string; pins: Set<string>; released: Set<string> }>();
  for (const info of await ctx.backups.list(`${ctx.location}backups/`)) {
    const m = /^backups\/([^/]+)\/(.+)$/.exec(info.key.slice(ctx.location.length));
    const parsed = m ? parseBackupId(m[1] ?? "") : null;
    if (!m || !parsed || parsed.env !== ctx.envName) continue;
    const id = m[1] ?? "";
    const rest = m[2] ?? "";
    const entry = byId.get(id) ?? { id, kind: parsed.kind, at: parsed.at, complete: false, verified: null, pinnedBy: [], newestWrite: 0, verifyKeys: [], verifyStamp: "", pins: new Set<string>(), released: new Set<string>() };
    entry.newestWrite = Math.max(entry.newestWrite, info.lastModified);
    if (rest === "manifest.json") entry.complete = true;
    const verifyStamp = /^verify\/(\d{8}T\d{6}Z)-/.exec(rest)?.[1];
    if (verifyStamp !== undefined && verifyStamp > entry.verifyStamp) {
      entry.verifyKeys = [info.key];
      entry.verifyStamp = verifyStamp;
    } else if (verifyStamp !== undefined && verifyStamp === entry.verifyStamp) entry.verifyKeys.push(info.key);
    const pin = /^pins\/([^/]+?)(\.released)?\.json$/.exec(rest);
    if (pin) (pin[2] ? entry.released : entry.pins).add(pin[1] ?? "");
    byId.set(id, entry);
  }
  const out: BackupSummary[] = [];
  for (const entry of byId.values()) {
    let newest: { at: number; ok: boolean } | null = null;
    for (const key of entry.verifyKeys) {
      const data = await ctx.backups.get(key);
      const value: unknown = data === null ? null : parseJsonOrNull(data);
      const at: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "at") : null;
      const record = { at: typeof at === "number" ? at : 0, ok: typeof value === "object" && value !== null && Reflect.get(value, "ok") === true };
      if (newest === null || record.at > newest.at || (record.at === newest.at && !record.ok)) newest = record;
    }
    if (newest !== null) entry.verified = newest.ok;
    out.push({ id: entry.id, kind: entry.kind, at: entry.at, complete: entry.complete, verified: entry.verified, newestWrite: entry.newestWrite, pinnedBy: [...entry.pins].filter((p) => !entry.released.has(p)) });
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** Releases a run's pin on a backup. */
export async function unpin(ctx: OpsContext, id: string, runId: string): Promise<void> {
  await ctx.backups.put(ctx.location + keys.unpin(id, runId), jsonBytes({ runId, at: ctx.clock() }), { contentType: "application/json" });
}

/** What {@link prune} removed, or would remove in a dry run. */
export interface PruneResult {
  dryRun: boolean;
  backups: string[];
  objects: string[];
  kept: string[];
}

/** Objects and incomplete backups younger than this are never removed. */
export const PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** A clock or protection probe older than this was left behind by a delete that failed; `prune` removes it. */
export const PROBE_MAX_AGE_MS = 60 * 60 * 1000;

const PROBE_DIRS = ["probes/", ".kestrel-clock/"];

async function removeStaleProbes(ctx: OpsContext, now: number): Promise<void> {
  const places: Array<[ObjectStore, string]> = [[ctx.backups, ctx.location]];
  if (ctx.env.backups.storage !== undefined) places.push([ctx.app, ctx.env.app.replicaPrefix]);
  const left: string[] = [];
  const failure = (key: string) => (cause: unknown): void => {
    if (cause instanceof Interrupted) throw cause;
    left.push(key);
  };
  for (const [store, base] of places) {
    for (const dir of PROBE_DIRS) {
      const listed = await store.list(base + dir).catch((cause: unknown) => {
        failure(base + dir)(cause);
        return [];
      });
      for (const info of listed) if (now - info.lastModified >= PROBE_MAX_AGE_MS) await store.delete(info.key).catch(failure(info.key));
    }
  }
  if (left.length > 0) ctx.out.warn(`${left.length} stale probe(s) could not be listed or removed with the tool's credentials, such as ${left[0] ?? ""}; prune went on without them, and they stay until credentials that may delete there run backup prune`);
}

const majorOfKestrel = (manifest: Manifest | null): string | null => {
  const version = manifest?.versions["@michaelthielemann/kestrel"] ?? manifest?.versions[REPLICATION_PACKAGE];
  if (version !== undefined) return version.split(".")[0] ?? null;
  return typeof manifest?.major === "number" ? String(manifest.major) : null;
};

const dayOf = (at: number): string => stamp(at).slice(0, 8);

async function recordRecent(ctx: OpsContext, id: string): Promise<void> {
  const day = dayOf(ctx.clock());
  for (let n = 0; ; n++) {
    const key = ctx.location + keys.recent(day, n);
    if ((await ctx.backups.head(key)) !== null) continue;
    await ctx.backups.put(key, jsonBytes({ backupId: id }), { contentType: "application/json" });
    return;
  }
}

async function recentBackupIds(ctx: Pick<OpsContext, "backups" | "location">, now: number): Promise<string[]> {
  const ids: string[] = [];
  for (const day of new Set([dayOf(now), dayOf(now - PRUNE_MIN_AGE_MS)])) {
    for (let n = 0; ; n++) {
      const data = await ctx.backups.get(ctx.location + keys.recent(day, n));
      if (data === null) break;
      const value: unknown = parseJson(data);
      const id: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "backupId") : null;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

async function backupIdsAtLocation(ctx: Pick<OpsContext, "backups" | "location">): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const info of await ctx.backups.list(`${ctx.location}backups/`)) {
    const m = /^backups\/([^/]+)\//.exec(info.key.slice(ctx.location.length));
    if (m?.[1] !== undefined) ids.add(m[1]);
  }
  return ids;
}

/**
 * Removes backups beyond the retention count of their kind and the objects no remaining backup refers to. Only
 * verified backups count towards the retention; a failed or unverified one is kept while it is newer than the oldest
 * verified backup the count keeps (or, when its kind has no verified backup, while it is among the newest of the
 * count). It keeps backups pinned by a run that has not ended (a run whose journal shows an end entry or no entry for
 * {@link RUN_STALE_MS} has ended), backups an update pinned (a pin whose run id starts with `UPDATE_PIN_PREFIX`),
 * whether or not that run ended, until the pin's `released` key exists, and the newest verified backup of every Kestrel major, never removes anything
 * younger than a day, keeps every object a backup of any environment at the same location refers to, also a backup
 * of today or yesterday that the listing does not show yet (read from `recent/`), and refuses while a run is open or
 * another run holds the lock. Unless `dryRun` is set, it then also removes the clock and protection probes older than
 * {@link PROBE_MAX_AGE_MS} that a refused delete left in the backup location, and below the replica prefix when the
 * backups live in a store of their own; a probe it cannot list or delete there is warned about once and left in place.
 */
export async function prune(ctx: OpsContext, dryRun: boolean): Promise<PruneResult> {
  const now = ctx.clock();
  const runs = await listRuns(ctx.backups, ctx.location);
  const ended = new Set(runs.filter((r) => r.finished || now - r.lastAt >= RUN_STALE_MS).map((r) => r.runId));
  const open = openRuns(runs, now).filter((r) => r.runId !== ctx.runId);
  if (open.length > 0) throw new OpsError(`refusing to prune: run ${open.map((r) => r.runId).join(", ")} is still open`, 1, "runs");
  const locks = (await heldLocks(ctx.backups, ctx.location, now)).filter((l) => l.runId !== ctx.runId);
  if (locks.length > 0) throw new OpsError(`refusing to prune: run ${locks.map((l) => l.runId).join(", ")} holds the lock`, 1, "lock");
  const all = await listBackups(ctx);
  const keep = new Set<string>();
  const remove: string[] = [];
  const manifests = new Map<string, Manifest | null>();
  const parsedManifest = (id: string): Promise<Manifest | null> => readManifest(ctx, id).catch((cause: unknown) => {
    if (cause instanceof OpsError && cause.element === "manifest.json") return null;
    throw cause;
  });
  for (const b of all) manifests.set(b.id, b.complete ? await parsedManifest(b.id) : null);
  for (const kind of BACKUP_KINDS) {
    const count = ctx.env.backups.retention[kind];
    const ofKind = all.filter((b) => b.kind === kind && b.complete).reverse();
    const verified = ofKind.filter((b) => b.verified === true).slice(0, count);
    verified.forEach((b) => keep.add(b.id));
    const oldest = verified.at(-1);
    const others = ofKind.filter((b) => b.verified !== true);
    (oldest === undefined ? others.slice(0, count) : others.filter((b) => b.at > oldest.at)).forEach((b) => keep.add(b.id));
  }
  const newestPerMajor = new Map<string, string>();
  for (const b of all) {
    const major = majorOfKestrel(manifests.get(b.id) ?? null);
    if (b.complete && b.verified === true && major !== null) newestPerMajor.set(major, b.id);
  }
  newestPerMajor.forEach((id) => keep.add(id));
  for (const b of all) {
    if (b.pinnedBy.some((runId) => runId.startsWith(UPDATE_PIN_PREFIX) || !ended.has(runId)) || now - b.newestWrite < PRUNE_MIN_AGE_MS) keep.add(b.id);
    if (!keep.has(b.id)) remove.push(b.id);
  }
  const referenced = new Set<string>();
  const removing = new Set(remove);
  const recent = await recentBackupIds(ctx, now);
  for (const id of new Set([...(await backupIdsAtLocation(ctx)), ...recent])) {
    if (removing.has(id) && !recent.includes(id)) continue;
    const manifest = manifests.has(id) ? (manifests.get(id) ?? null) : await parsedManifest(id);
    for (const [list, file, part] of [[await readJsonl<BlobEntry>(ctx, ctx.location + keys.blobs(id)), "blobs.jsonl", "blobs"], [await readJsonl<SiteEntry>(ctx, ctx.location + keys.site(id)), "site.jsonl", "site"]] as const) {
      if ("unreadable" in list) throw new OpsError(`refusing to prune: ${file} of backup ${id} holds ${list.unreadable}, so the objects it refers to are unknown`, 1, file);
      if (!("entries" in list)) continue;
      const count = countedEntries(manifest, part);
      if (count !== null && list.entries.length !== count) throw new OpsError(`refusing to prune: ${file} of backup ${id} ${entryCountMismatch(list.entries.length, count)}, so the objects it refers to are unknown`, 1, file);
      for (const entry of list.entries) referenced.add(ctx.location + entry.object);
    }
  }
  const objects = (await ctx.backups.list(`${ctx.location}objects/`)).filter((o) => !referenced.has(o.key) && now - o.lastModified >= PRUNE_MIN_AGE_MS).map((o) => o.key);
  const result: PruneResult = { dryRun, backups: remove, objects, kept: [...keep].sort() };
  if (dryRun) return result;
  const oldest = dayOf(now - PRUNE_MIN_AGE_MS);
  for (const info of await ctx.backups.list(`${ctx.location}recent/`)) {
    const day = /^recent\/(\d{8})\//.exec(info.key.slice(ctx.location.length))?.[1];
    if (day !== undefined && day < oldest) await ctx.backups.delete(info.key);
  }
  const due = remove.length > 0 || objects.length > 0;
  if (due) {
    await confirm(ctx.answers, "prune-delete", fixedText`prune removes ${remove.length} backup(s) and ${objects.length} object(s)`);
    for (const id of remove) for (const info of await ctx.backups.list(ctx.location + keys.backupDir(id))) await ctx.backups.delete(info.key);
    for (const key of objects) await ctx.backups.delete(key);
  }
  await removeStaleProbes(ctx, now);
  if (due) await ctx.journal.record("prune", "done", { backups: remove, objects: objects.length });
  return result;
}
