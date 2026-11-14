import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acceptSeal, createBackup, readManifest, verifyBackup, type BackupMode } from "./backup.ts";
import { runtimeVersion, startTarget, stopTarget, type OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";
import { fromJsonl, keys, type BlobEntry, type Manifest, type SiteEntry } from "./layout.ts";
import { confirm } from "./questions.ts";
import { acknowledgement, buildDatabase, checkPromotable, completeGeneration, promote, promotionName, sealOf, stableGenerations, type Acknowledgement, type Promoted, type SealReport } from "./replica.ts";
import { appClock } from "./serverTime.ts";
import { deleteSessions, hasAccessChanges, integrityCheck, lossReport, sha256, vacuumInto, type LossReport } from "./sqlite.ts";
import { listMap, stableList, transfer, type ObjectInfo } from "./store.ts";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

/** Options of {@link restoreBackup}. */
export interface RestoreOptions {
  backupId: string;
  /** Skip the `pre-restore` backup of the current state. Only an explicit flag sets it, never `--yes`. */
  noSafetyBackup?: boolean;
}

/** What a restore did. */
export interface RestoreResult {
  backupId: string;
  /** Nothing differed from the backup: the app was started again without promoting or copying anything. */
  noop: boolean;
  /** Null when the current replica could not be read, after the `unreadable-current` answer. */
  loss: LossReport | null;
  safetyBackup: string | null;
  sessionsDeleted: number;
  originalsRestored: string[];
  /** Originals the store holds that the backup's rows do not reference, such as uploads made after it; they stay. */
  newerOriginals: string[];
  delivery: { written: string[]; removed: string[] };
  promoted: Promoted | null;
  acknowledgement: Acknowledgement | null;
}

async function entries<T>(ctx: OpsContext, key: string): Promise<T[]> {
  const data = await ctx.backups.get(key);
  if (data === null) throw new OpsError(`${key} is missing`, 1, key);
  return boundaryCast<T[]>(fromJsonl(data), "json");
}

function noDatabase(manifest: Manifest): OpsError {
  return new OpsError(`backup ${manifest.id} holds no database: it was taken while the replica could not be read; blobs.jsonl and site.jsonl list its originals and delivery keys`, 1, manifest.id);
}

async function downloadDb(ctx: OpsContext, manifest: Manifest, file: string): Promise<void> {
  if (manifest.db === null) throw noDatabase(manifest);
  const data = await ctx.backups.get(ctx.location + keys.db(manifest.id));
  if (data === null || sha256(data) !== manifest.db.sha256) throw new OpsError(`backup ${manifest.id}: db.sqlite is missing or differs from its manifest`, 1, "db.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

const isVersionOf = (info: ObjectInfo | null | undefined, entry: BlobEntry | SiteEntry): boolean => info !== null && info !== undefined && info.size === entry.size && (info.etag === entry.etag || info.etag === entry.objectEtag);

async function waitForVersion(ctx: OpsContext, entry: SiteEntry): Promise<boolean> {
  const sleep = ctx.poll.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let i = 0; i < (ctx.poll.attempts ?? 30); i++) {
    if (isVersionOf(await ctx.app.head(entry.key), entry)) return true;
    await sleep(ctx.poll.delayMs ?? 1000);
  }
  return false;
}

async function restoreOriginals(ctx: OpsContext, blobs: readonly BlobEntry[], dryRun: boolean): Promise<string[]> {
  const live = await listMap(ctx.app, ctx.env.app.mediaPrefix);
  const restored: string[] = [];
  for (const entry of blobs) {
    const current = live.get(entry.key) ?? (await ctx.app.head(entry.key));
    if (isVersionOf(current, entry)) continue;
    restored.push(entry.key);
    if (!dryRun) await transfer(ctx.backups, ctx.location + entry.object, ctx.app, entry.key);
  }
  return restored;
}

async function restoreDelivery(ctx: OpsContext, site: readonly SiteEntry[], dryRun: boolean): Promise<{ written: string[]; removed: string[] }> {
  const live = new Map((await stableList(ctx.app, ctx.env.app.deliveryPrefix, ctx.poll)).map((info) => [info.key, info]));
  const wanted = new Map(site.map((s) => [s.key, s]));
  const written: string[] = [];
  for (const entry of site) {
    if (isVersionOf(live.get(entry.key), entry)) continue;
    written.push(entry.key);
    if (!dryRun) await transfer(ctx.backups, ctx.location + entry.object, ctx.app, entry.key);
  }
  if (!dryRun) for (const key of written) {
    const entry = wanted.get(key);
    if (entry && !(await waitForVersion(ctx, entry))) ctx.out.warn(`${key} does not read back with the restored version yet`);
  }
  const removed = [...live.keys()].filter((key) => !wanted.has(key));
  if (!dryRun) for (const key of removed) await ctx.app.delete(key);
  return { written, removed };
}

function describeLoss(ctx: OpsContext, loss: LossReport): string[] {
  const lines = [`changes since ${new Date(loss.since).toISOString()} that the restore discards or reverts:`];
  for (const [table, d] of Object.entries(loss.tables)) lines.push(`  ${table}: ${d.added} newer row(s) dropped, ${d.changed} changed row(s) reverted, ${d.removed} deleted row(s) back`);
  if (loss.auditEntriesAfter > 0) lines.push(`  audit entries after the backup: ${loss.auditEntriesAfter}`);
  const a = loss.access;
  const access: Array<[string, string[]]> = [
    ["users created after the backup, removed", a.created],
    ["users deleted after the backup, back", a.deleted],
    ["users deactivated after the backup, active again", a.deactivated],
    ["users whose roles changed, old roles back", a.rolesChanged],
    ["second factors reset after the backup, old factor back", a.mfaReset],
  ];
  lines.push("access changes:");
  if (!hasAccessChanges(loss)) lines.push("  none");
  for (const [label, users] of access) if (users.length > 0) lines.push(`  ${label}: ${users.join(", ")}`);
  for (const line of lines) ctx.out.info(line);
  return lines;
}

/**
 * Restores a backup over the environment: verifies the backup, stops the app, reports what the restore discards
 * (with explicit consent for access changes), takes a `pre-restore` backup of the stopped state, copies originals
 * back without deleting any, replaces the delivery prefix, empties the login sessions of the restored database,
 * promotes it as the newest replica generation (or places it for a target that keeps its disk) and starts the app.
 */
export async function restoreBackup(ctx: OpsContext, options: RestoreOptions): Promise<RestoreResult> {
  const manifest = await readManifest(ctx, options.backupId);
  if (manifest === null) throw new OpsError(`backup ${options.backupId} does not exist or is incomplete`, 1, options.backupId);
  if (manifest.env !== ctx.envName) throw new OpsError(`backup ${options.backupId} belongs to environment ${manifest.env}, not ${ctx.envName}`, 1, options.backupId);
  if (manifest.db === null) throw noDatabase(manifest);
  const check = await verifyBackup(ctx, manifest.id);
  if (!check.ok) throw new OpsError(`backup ${manifest.id} failed verification: ${check.problems.map((p) => `${p.element}: ${p.message}`).join("; ")}`, 1, check.problems[0]?.element);
  await ctx.journal.record("restore", "started", { backupId: manifest.id });

  await confirm(ctx.answers, "confirm", `restore ${manifest.id} (${new Date(manifest.createdAt).toISOString()}) over ${ctx.envName}: the app stops now`);
  const stop = await stopTarget(ctx);
  const state = { changed: false };
  try {
    return await restoreStopped(ctx, manifest, stop, state, options);
  } catch (error) {
    if (state.changed) {
      ctx.out.error(`the restore stopped after it changed the store; the app stays stopped. Run the restore again, or restore the pre-restore backup`);
      throw error;
    }
    if (stop.wasRunning) await startTarget(ctx).catch((cause: unknown) => ctx.out.error(`starting the app again failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    throw error;
  }
}

type Current = { kind: "readable"; seal: SealReport; file: string } | { kind: "unreadable"; reason: string };

async function readCurrent(ctx: OpsContext, stoppedAt: number): Promise<Current> {
  const prefix = ctx.env.app.replicaPrefix;
  let seal: SealReport;
  try {
    const newest = (await stableGenerations(ctx.app, prefix, ctx.poll)).at(-1);
    if (!newest) return { kind: "unreadable", reason: `the replica under ${prefix} has no generation` };
    seal = await sealOf(ctx.app, prefix, newest, runtimeVersion(await ctx.target.describe()), ctx.poll);
  } catch (cause) {
    if (cause instanceof OpsError) return { kind: "unreadable", reason: cause.message };
    throw cause;
  }
  await acceptSeal(ctx, seal, stoppedAt);
  const file = ctx.workspace.path("current.db");
  try {
    await buildDatabase(ctx.app, prefix, seal.listed, file);
  } catch (cause) {
    if (cause instanceof OpsError) return { kind: "unreadable", reason: cause.message };
    throw cause;
  }
  return { kind: "readable", seal, file };
}

async function restoreStopped(ctx: OpsContext, manifest: Manifest, stop: { stoppedAt: number }, state: { changed: boolean }, options: RestoreOptions): Promise<RestoreResult> {
  const blobs = await entries<BlobEntry>(ctx, ctx.location + keys.blobs(manifest.id));
  const site = await entries<SiteEntry>(ctx, ctx.location + keys.site(manifest.id));
  const restoredDb = ctx.workspace.path("backup.db");
  await downloadDb(ctx, manifest, restoredDb);
  const current = await readCurrent(ctx, stop.stoppedAt);
  let loss: LossReport | null = null;
  if (current.kind === "unreadable") {
    const lines = [`the current database cannot be read: ${current.reason}`, "the restore cannot report what it discards, and its pre-restore backup holds the originals and delivery keys but no database"];
    for (const line of lines) ctx.out.warn(line);
    await ctx.journal.record("loss-report", "failed", { reason: current.reason });
    await confirm(ctx.answers, "unreadable-current", lines.join("\n"));
    if (ctx.env.production) await confirm(ctx.answers, "access-changes", [...lines, "access changes cannot be listed; every login session ends; everyone signs in again"].join("\n"));
  } else {
    loss = lossReport(current.file, restoredDb, manifest.source.lastFrameAt ?? manifest.createdAt);
    const lines = describeLoss(ctx, loss);
    await ctx.journal.record("loss-report", "done", { tables: loss.tables, auditEntriesAfter: loss.auditEntriesAfter, access: loss.access });
    if (ctx.env.production || hasAccessChanges(loss)) await confirm(ctx.answers, "access-changes", [...lines, "every login session ends; everyone signs in again"].join("\n"));
  }

  const originals = await restoreOriginals(ctx, blobs, true);
  const delivery = await restoreDelivery(ctx, site, true);
  const referenced = new Set(blobs.map((b) => b.key));
  const newerOriginals = [...(await listMap(ctx.app, ctx.env.app.mediaPrefix)).keys()].filter((k) => !referenced.has(k));
  if (newerOriginals.length > 0) ctx.out.info(`${newerOriginals.length} original(s) in the store are not in the backup and stay: ${newerOriginals.slice(0, 10).join(", ")}${newerOriginals.length > 10 ? ", …" : ""}`);
  const base: RestoreResult = { backupId: manifest.id, noop: false, loss, safetyBackup: null, sessionsDeleted: 0, originalsRestored: originals, newerOriginals, delivery, promoted: null, acknowledgement: null };
  if (loss?.identical === true && originals.length === 0 && delivery.written.length === 0 && delivery.removed.length === 0) {
    ctx.out.info("nothing differs from the backup; starting the app again");
    await startTarget(ctx);
    await ctx.journal.record("restore", "done", { backupId: manifest.id, noop: true });
    return { ...base, noop: true };
  }

  const clock = ctx.target.transport === "promote" ? await appClock(ctx) : null;
  if (clock !== null) {
    checkPromotable(await ctx.target.status(), clock.skewMs);
    promotionName(await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll), clock.now());
  }
  else if (!ctx.target.installDatabase) throw new OpsError("the target can take neither a promoted generation nor a database file", 2, "target");

  let safetyBackup: string | null = null;
  if (options.noSafetyBackup) ctx.out.warn("no pre-restore backup: --no-safety-backup");
  else {
    const mode: BackupMode = current.kind === "unreadable" ? { kind: "unreadable", reason: current.reason, stoppedAt: stop.stoppedAt } : { kind: "stopped", seal: current.seal, stoppedAt: stop.stoppedAt };
    safetyBackup = (await createBackup(ctx, { kind: "pre-restore", mode, pinFor: ctx.runId })).id;
    ctx.out.info(`pre-restore backup ${safetyBackup} written and verified`);
  }

  state.changed = true;
  await restoreOriginals(ctx, blobs, false);
  await restoreDelivery(ctx, site, false);
  await ctx.journal.record("blobs", "done", { originals: originals.length, deliveryWritten: delivery.written.length, deliveryRemoved: delivery.removed.length });

  const sessionsDeleted = deleteSessions(restoredDb);
  const prepared = ctx.workspace.path("restore.db");
  vacuumInto(restoredDb, prepared);
  const verdict = integrityCheck(prepared);
  if (verdict !== "ok") throw new OpsError(`the database to restore fails integrity_check: ${verdict}`, 1, "db.sqlite");
  let promoted: Promoted | null = null;
  let ack: Acknowledgement | null = null;
  if (clock !== null) {
    promoted = await promote({ store: ctx.app, prefix: ctx.env.app.replicaPrefix, target: ctx.target, database: prepared, origin: { kind: "restore", source: manifest.id }, serverNow: clock.now, skewMs: clock.skewMs, clock: ctx.clock, poll: ctx.poll });
    await ctx.journal.record("promote", "done", { generation: promoted.generation, sha256: promoted.sha256 });
    const sleep = ctx.poll.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    while (clock.now() <= promoted.at) await sleep(Math.min(1000, promoted.at - clock.now() + 1));
  } else {
    if (!ctx.target.installDatabase) throw new OpsError("the target can take neither a promoted generation nor a database file", 2, "target");
    await ctx.target.installDatabase(prepared);
    await ctx.journal.record("install-database", "done", {});
  }
  await startTarget(ctx);
  if (promoted !== null) {
    ack = await acknowledgement(ctx.app, ctx.env.app.replicaPrefix, promoted, ctx.poll);
    const gens = await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll);
    ctx.out.info(ack === "applied" ? `the app reports the restore of ${promoted.generation}` : `the app did not acknowledge ${promoted.generation}; a runtime without restore reporting renders nothing again by itself`);
    if (gens.at(-1)?.name === promoted.generation) ctx.out.warn("the app has not started its own generation yet");
  }
  await ctx.journal.record("restore", "done", { backupId: manifest.id, safetyBackup, acknowledgement: ack });
  return { ...base, safetyBackup, sessionsDeleted, promoted, acknowledgement: ack };
}

/** Options of {@link restoreToLocal}. */
export interface LocalRestoreOptions {
  dir: string;
  /** A backup id, or null for the newest replica generation. */
  backupId: string | null;
  withMedia: boolean;
  keepSessions: boolean;
}

/** Writes a backup's database (or the newest replica generation) to `<dir>/kestrel.db`, sessions removed unless kept, optionally with the originals under `<dir>/blobs/`. */
export async function restoreToLocal(ctx: OpsContext, options: LocalRestoreOptions): Promise<{ file: string; sessionsDeleted: number; originals: number }> {
  const dir = resolve(options.dir);
  const file = join(dir, "kestrel.db");
  if (options.withMedia && options.backupId === null) throw new OpsError("--with-media needs --backup <id>", 2, "--with-media");
  if (existsSync(file)) throw new OpsError(`${file} exists; choose an empty directory`, 1, file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = ctx.workspace.path("local-source.db");
  let blobs: BlobEntry[] = [];
  if (options.backupId === null) {
    const newest = (await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll)).at(-1);
    if (!newest) throw new OpsError(`the replica under ${ctx.env.app.replicaPrefix} has no generation`, 1, ctx.env.app.replicaPrefix);
    await buildDatabase(ctx.app, ctx.env.app.replicaPrefix, await completeGeneration(ctx.app, ctx.env.app.replicaPrefix, newest, ctx.poll), source);
  } else {
    const manifest = await readManifest(ctx, options.backupId);
    if (manifest === null) throw new OpsError(`backup ${options.backupId} does not exist or is incomplete`, 1, options.backupId);
    await downloadDb(ctx, manifest, source);
    blobs = await entries<BlobEntry>(ctx, ctx.location + keys.blobs(manifest.id));
  }
  const sessionsDeleted = options.keepSessions ? 0 : deleteSessions(source);
  closeSync(openSync(file, "wx", 0o600));
  try {
    vacuumInto(source, file);
  } catch (cause) {
    rmSync(file, { force: true });
    throw cause;
  }
  let originals = 0;
  if (options.withMedia) {
    const bytes = blobs.reduce((n, b) => n + b.size, 0);
    await confirm(ctx.answers, "confirm", `download ${blobs.length} original(s), ${(bytes / 1024 / 1024).toFixed(1)} MiB, into ${dir}/blobs`);
    for (const entry of blobs) {
      const data = await ctx.backups.get(ctx.location + entry.object);
      if (data === null) throw new OpsError(`backup object ${entry.object} is missing`, 1, entry.key);
      const out = join(dir, "blobs", entry.key);
      if (!resolve(out).startsWith(join(dir, "blobs") + "/")) throw new OpsError(`refusing to write ${entry.key} outside ${dir}/blobs`, 1, entry.key);
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
      writeFileSync(out, data, { mode: 0o600 });
      originals += 1;
    }
  }
  return { file, sessionsDeleted, originals };
}
