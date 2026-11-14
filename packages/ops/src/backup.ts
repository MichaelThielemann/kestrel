import { statSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { messageOf, REPLICATION_PACKAGE, runtimeVersion, startTarget, stopTarget, type OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";
import { openRuns, listRuns } from "./journal.ts";
import { heldLocks } from "./lock.ts";
import { BACKUP_KINDS, backupId, fromJsonl, jsonBytes, keys, parseBackupId, parseJson, stamp, toJsonl, type BackupKind, type BlobEntry, type DerivedEntry, type Manifest, type SiteEntry } from "./layout.ts";
import { refuseUnfinishedPlacement } from "./placements.ts";
import { confirm } from "./questions.ts";
import { buildDatabase, completeGeneration, SEALING_MAJOR, sealOf, stableGenerations, type SealReport } from "./replica.ts";
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
  /** Pin the backup for this run, so prune keeps it while the run is open. */
  pinFor?: string;
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
      ? `seal unsupported (runtime ${seal.runtime ?? "unknown"}): the replica cannot prove the stop shipped every frame`
      : seal.state === "unknown"
        ? `seal unknown: generation ${seal.generation} has no seal and the target does not report the replication runtime version; a runtime before ${SEALING_MAJOR} writes none, a later one stopped without teardown`
        : `unsealed: generation ${seal.generation} has no seal; the stop went without teardown`,
    `last shipped segment ${lastFrame}, stopped ${new Date(stoppedAt).toISOString()}`,
    ...evidence,
  ];
  for (const line of lines) ctx.out.warn(line);
  await confirm(ctx.answers, "unsealed-stop", lines.join("\n"));
}

/** Reads the newest generation of the stopped replica and classifies its seal. */
export async function readSeal(ctx: OpsContext): Promise<SealReport> {
  const gens = await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll);
  const newest = gens.at(-1);
  if (!newest) throw new OpsError(`the replica under ${ctx.env.app.replicaPrefix} has no generation`, 1, ctx.env.app.replicaPrefix);
  await refuseUnfinishedPlacement(ctx, gens);
  return sealOf(ctx.app, ctx.env.app.replicaPrefix, newest, runtimeVersion(await ctx.target.describe()), ctx.poll);
}

type CopiedEntry = { key: string; size: number; etag: string; object: string; objectEtag: string };

async function copyIntoObjects(ctx: OpsContext, info: ObjectInfo, existing: Map<string, ObjectInfo>, checksum: string | null = null): Promise<{ entry: CopiedEntry; copied: boolean } | null> {
  let current: ObjectInfo | null = info;
  for (let attempt = 0; attempt < COPY_ATTEMPTS && current !== null; attempt++) {
    const source: ObjectInfo = current;
    const objectKey = keys.object(source.key, source.etag);
    const object = ctx.location + objectKey;
    const entry = (objectEtag: string): CopiedEntry => ({ key: source.key, size: source.size, etag: source.etag, object: objectKey, objectEtag });
    const known = existing.get(object) ?? (await ctx.backups.head(object));
    if (known && known.size === source.size) return { entry: entry(known.etag), copied: false };
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
      if (streamed !== null && checksum !== null && sha256(streamed) !== checksum) throw new OpsError(`the copy of ${source.key} does not hash to the checksum of its media row`, 1, source.key);
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
  const refs = dbFile === null ? [...live.keys()].map((key) => ({ key, sha256: null })) : referencedBlobs(dbFile, app.media);
  for (const ref of refs) {
    const info = live.get(ref.key) ?? (await ctx.app.head(ref.key));
    const copied = info === null ? null : await copyIntoObjects(ctx, info, existing, ref.sha256);
    if (copied === null) missing.push(ref.key);
    else blobs.push({ ...copied.entry, sha256: ref.sha256 });
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
    versions: { ...ctx.project.versions, ...facts.packages },
    node: process.version,
    lockfileSha256: ctx.project.lockfileSha256,
    db,
    blobs: { count: blobs.length, bytes: blobs.reduce((n, b) => n + b.size, 0), missingAtBackup: missing },
    site: { prefix: app.deliveryPrefix, count: site.length, bytes: site.reduce((n, s) => n + s.size, 0), pathsSha256: sha256(site.map((s) => s.key).join("\n")) },
    derived: derivedTotals,
    target: facts,
  };
  await putNew(ctx.backups, ctx.location + keys.manifest(id), new TextEncoder().encode(ctx.redactor.json(manifest, 2) + "\n"), "application/json");
  for (const key of missing) ctx.out.warn(`original ${key} is referenced by a media row but missing in the store`);
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
  const value = parseJson(data);
  if (!isManifest(value)) throw new OpsError(`backup ${id}: manifest.json has an unknown format`, 1, "manifest.json");
  return value;
}

async function readJsonl<T>(ctx: OpsContext, key: string): Promise<T[] | null> {
  const data = await ctx.backups.get(key);
  return data === null ? null : boundaryCast<T[]>(fromJsonl(data), "json");
}

/** How many originals verification hashes: 25 or 2 %, whichever is more, at most 200. */
export function sampleSize(total: number): number {
  return Math.min(total, Math.min(200, Math.max(25, Math.ceil(total * 0.02))));
}

/**
 * Verifies a backup from what the backup location holds: the database (when the backup has one) is read back, hashed and fully
 * integrity-checked, its rows are counted against the manifest, every referenced original and every delivery key has
 * its entry and an object of the recorded size, and a sample of originals hashes to the checksum of its row. An
 * object the listing does not show yet is looked up by a HEAD before it counts as missing.
 */
export async function verifyBackup(ctx: OpsContext, id: string): Promise<Verification> {
  const problems: Problem[] = [];
  const checked = { tables: 0, blobs: 0, site: 0, sampled: 0 };
  const finish = async (): Promise<Verification> => {
    const result: Verification = { id, at: ctx.clock(), ok: problems.length === 0, checked, problems };
    await ctx.backups.put(ctx.location + keys.verification(id, result.at), jsonBytes(result), { contentType: "application/json" });
    return result;
  };
  const manifest = await readManifest(ctx, id);
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
  const blobs = await readJsonl<BlobEntry>(ctx, ctx.location + keys.blobs(id));
  const site = await readJsonl<SiteEntry>(ctx, ctx.location + keys.site(id));
  if (blobs === null) problems.push({ element: "blobs.jsonl", message: "missing" });
  if (site === null) problems.push({ element: "site.jsonl", message: "missing" });
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
  const hashed = (blobs ?? []).filter((b) => b.sha256 !== null && objects.has(ctx.location + b.object));
  const step = hashed.length / Math.max(1, sampleSize(hashed.length));
  for (let i = 0; i < sampleSize(hashed.length); i++) {
    const entry = hashed[Math.floor(i * step)];
    if (!entry) continue;
    checked.sampled += 1;
    const bytes = await ctx.backups.get(ctx.location + entry.object);
    if (bytes === null || sha256(bytes) !== entry.sha256) problems.push({ element: entry.key, message: `backup object ${entry.object} does not hash to the checksum of its media row` });
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
  const byId = new Map<string, BackupSummary & { verifyKey: string | null; verifyRest: string; pins: Set<string>; released: Set<string> }>();
  for (const info of await ctx.backups.list(`${ctx.location}backups/`)) {
    const m = /^backups\/([^/]+)\/(.+)$/.exec(info.key.slice(ctx.location.length));
    const parsed = m ? parseBackupId(m[1] ?? "") : null;
    if (!m || !parsed || parsed.env !== ctx.envName) continue;
    const id = m[1] ?? "";
    const rest = m[2] ?? "";
    const entry = byId.get(id) ?? { id, kind: parsed.kind, at: parsed.at, complete: false, verified: null, pinnedBy: [], newestWrite: 0, verifyKey: null, verifyRest: "", pins: new Set<string>(), released: new Set<string>() };
    entry.newestWrite = Math.max(entry.newestWrite, info.lastModified);
    if (rest === "manifest.json") entry.complete = true;
    if (rest.startsWith("verify/") && (entry.verifyKey === null || rest > entry.verifyRest)) {
      entry.verifyKey = info.key;
      entry.verifyRest = rest;
    }
    const pin = /^pins\/([^/]+?)(\.released)?\.json$/.exec(rest);
    if (pin) (pin[2] ? entry.released : entry.pins).add(pin[1] ?? "");
    byId.set(id, entry);
  }
  const out: BackupSummary[] = [];
  for (const entry of byId.values()) {
    if (entry.verifyKey !== null) {
      const data = await ctx.backups.get(entry.verifyKey);
      const value: unknown = data === null ? null : parseJson(data);
      entry.verified = typeof value === "object" && value !== null && Reflect.get(value, "ok") === true;
    }
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

const majorOfKestrel = (manifest: Manifest | null): string | null => {
  const version = manifest?.versions["@michaelthielemann/kestrel"] ?? manifest?.versions[REPLICATION_PACKAGE];
  return version === undefined ? null : (version.split(".")[0] ?? null);
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
 * count). It keeps pinned backups and the newest verified backup of every Kestrel major, never removes anything
 * younger than a day, keeps every object a backup of any environment at the same location refers to, also a backup
 * of today or yesterday that the listing does not show yet (read from `recent/`), and refuses while a run is open or
 * another run holds the lock.
 */
export async function prune(ctx: OpsContext, dryRun: boolean): Promise<PruneResult> {
  const now = ctx.clock();
  const open = openRuns(await listRuns(ctx.backups, ctx.location), now).filter((r) => r.runId !== ctx.runId);
  if (open.length > 0) throw new OpsError(`refusing to prune: run ${open.map((r) => r.runId).join(", ")} is still open`, 1, "runs");
  const locks = (await heldLocks(ctx.backups, ctx.location, now)).filter((l) => l.runId !== ctx.runId);
  if (locks.length > 0) throw new OpsError(`refusing to prune: run ${locks.map((l) => l.runId).join(", ")} holds the lock`, 1, "lock");
  const all = await listBackups(ctx);
  const keep = new Set<string>();
  const remove: string[] = [];
  const manifests = new Map<string, Manifest | null>();
  for (const b of all) manifests.set(b.id, b.complete ? await readManifest(ctx, b.id) : null);
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
    if (b.pinnedBy.length > 0 || now - b.newestWrite < PRUNE_MIN_AGE_MS) keep.add(b.id);
    if (!keep.has(b.id)) remove.push(b.id);
  }
  const referenced = new Set<string>();
  const removing = new Set(remove);
  const recent = await recentBackupIds(ctx, now);
  for (const id of new Set([...(await backupIdsAtLocation(ctx)), ...recent])) {
    if (removing.has(id) && !recent.includes(id)) continue;
    for (const list of [await readJsonl<BlobEntry>(ctx, ctx.location + keys.blobs(id)), await readJsonl<SiteEntry>(ctx, ctx.location + keys.site(id))]) for (const entry of list ?? []) referenced.add(ctx.location + entry.object);
  }
  const objects = (await ctx.backups.list(`${ctx.location}objects/`)).filter((o) => !referenced.has(o.key) && now - o.lastModified >= PRUNE_MIN_AGE_MS).map((o) => o.key);
  const result: PruneResult = { dryRun, backups: remove, objects, kept: [...keep].sort() };
  if (!dryRun) {
    const oldest = dayOf(now - PRUNE_MIN_AGE_MS);
    for (const info of await ctx.backups.list(`${ctx.location}recent/`)) {
      const day = /^recent\/(\d{8})\//.exec(info.key.slice(ctx.location.length))?.[1];
      if (day !== undefined && day < oldest) await ctx.backups.delete(info.key);
    }
  }
  if (dryRun || (remove.length === 0 && objects.length === 0)) return result;
  await confirm(ctx.answers, "prune-delete", `prune removes ${remove.length} backup(s) and ${objects.length} object(s)`);
  for (const id of remove) for (const info of await ctx.backups.list(ctx.location + keys.backupDir(id))) await ctx.backups.delete(info.key);
  for (const key of objects) await ctx.backups.delete(key);
  await ctx.journal.record("prune", "done", { backups: remove, objects: objects.length });
  return result;
}
