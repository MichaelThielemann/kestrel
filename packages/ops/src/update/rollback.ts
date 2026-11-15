import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { acceptSeal, createBackup, readManifest, readSeal } from "../backup.ts";
import { messageOf, recordQuietly, startTarget, stopTarget } from "../context.ts";
import { OpsError } from "../errors.ts";
import { fromJsonl, hex, keys, parseJsonOrNull, type BlobEntry, type DerivedEntry, type Manifest, type SealState, type SiteEntry } from "../layout.ts";
import { acknowledgement, buildDatabase, completeGeneration, listGenerations, markerKey, promote, stableGenerations, type Promoted } from "../replica.ts";
import { MASK } from "../redact.ts";
import { downloadDb, restoreDelivery, restoreOriginals } from "../restore.ts";
import { appClock, type ServerClock } from "../serverTime.ts";
import { deleteSessions, hasAccessChanges, lossReport, sha256, type LossReport } from "../sqlite.ts";
import { stableList, type ObjectInfo } from "../store.ts";
import { releaseUpdatePin } from "./cleanup.ts";
import { readUpdateRun, reportOf } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import type { ConfigurationRestore, RecordedConfiguration } from "./target.ts";
import { UPDATE_EXIT, type DerivedReport, type RollbackReason, type RollbackResult, type UpdateContext, type UpdateExitCode, type UpdateOutcome, type UpdateRun, type UpdateRunState } from "./types.ts";

/** The table a rollback adds to the database it promotes for a release before 6, holding one marker row per rollback. */
export const PROVENANCE_TABLE = "kestrel_ops_provenance";

const DELIVERY_PASSES = 5;

const sleepOf = (ctx: UpdateContext): ((ms: number) => Promise<void>) => ctx.poll.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

async function jsonl<T>(ctx: UpdateContext, key: string): Promise<T[]> {
  const data = await ctx.backups.get(ctx.location + key);
  if (data === null) throw new OpsError(`${key} is missing`, 1, key);
  return boundaryCast<T[]>(fromJsonl(data), "json");
}

function isRecordedConfiguration(value: unknown): value is RecordedConfiguration {
  return typeof value === "object" && value !== null && Reflect.get(value, "schema") === "kestrel-ops/configuration@1" && typeof Reflect.get(value, "env") === "object" && typeof Reflect.get(value, "salt") === "string";
}

async function recordedConfiguration(ctx: UpdateContext, runId: string): Promise<RecordedConfiguration | null> {
  const data = await ctx.backups.get(ctx.location + updateKeys.configuration(ctx.envName, runId));
  const value: unknown = data === null ? null : parseJsonOrNull(data);
  if (data !== null && !isRecordedConfiguration(value)) throw new OpsError(`the recorded configuration of run ${runId} cannot be read`, 1, "configuration.json");
  return isRecordedConfiguration(value) ? value : null;
}

function withoutMasks(recorded: RecordedConfiguration): RecordedConfiguration {
  const env: RecordedConfiguration["env"] = {};
  for (const [name, value] of Object.entries(recorded.env)) env[name] = "value" in value && value.value.includes(MASK) ? { fingerprint: "" } : value;
  return { ...recorded, env };
}

function writeMarker(file: string, nonce: string, runId: string, at: number): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS "${PROVENANCE_TABLE}" ("nonce" TEXT PRIMARY KEY, "run" TEXT NOT NULL, "at" REAL NOT NULL)`);
    db.prepare(`INSERT INTO "${PROVENANCE_TABLE}" ("nonce", "run", "at") VALUES (?, ?, ?)`).run(nonce, runId, at);
  } finally {
    db.close();
  }
}

function holdsMarker(file: string, nonce: string): boolean {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(PROVENANCE_TABLE) === undefined) return false;
    return db.prepare(`SELECT 1 FROM "${PROVENANCE_TABLE}" WHERE "nonce" = ?`).get(nonce) !== undefined;
  } finally {
    db.close();
  }
}

async function waitUntilStartable(ctx: UpdateContext, at: number, clock: ServerClock): Promise<void> {
  const sleep = sleepOf(ctx);
  const behind = (): number => at + 1000 - Math.min(clock.now(), ctx.clock());
  while (behind() > 0) await sleep(Math.min(1000, behind()));
}

async function holdsEntry(ctx: UpdateContext, info: ObjectInfo, entry: SiteEntry): Promise<boolean> {
  if (info.size !== entry.size) return false;
  if (info.etag === entry.etag || info.etag === entry.objectEtag) return true;
  const live = await ctx.app.get(info.key);
  const copy = await ctx.backups.get(ctx.location + entry.object);
  return live !== null && copy !== null && sha256(live) === sha256(copy);
}

async function replaceDelivery(ctx: UpdateContext, site: readonly SiteEntry[], clock: ServerClock): Promise<RollbackResult["delivery"]> {
  const written = new Set<string>();
  const removed = new Set<string>();
  const wanted = new Map(site.map((entry) => [entry.key, entry]));
  for (let pass = 1; ; pass++) {
    const startedAt = clock.now();
    const done = await restoreDelivery(ctx, site, false);
    done.written.forEach((key) => written.add(key));
    done.removed.forEach((key) => removed.add(key));
    const live = await stableList(ctx.app, ctx.env.app.deliveryPrefix, ctx.poll);
    const stray: string[] = [];
    for (const info of live) {
      const entry = wanted.get(info.key);
      if (entry === undefined || (info.lastModified >= startedAt - 1000 && !(await holdsEntry(ctx, info, entry))) || info.size !== entry.size) stray.push(info.key);
    }
    const listed = new Set(live.map((info) => info.key));
    stray.push(...site.filter((entry) => !listed.has(entry.key)).map((entry) => entry.key));
    if (stray.length === 0) return { written: [...written].sort(), removed: [...removed].sort(), relisted: pass };
    if (pass >= DELIVERY_PASSES) throw new OpsError(`the delivery prefix ${ctx.env.app.deliveryPrefix} still changed after ${pass} replacements (${stray.slice(0, 5).join(", ")}): a render keeps writing; check that no instance of the app runs`, 1, ctx.env.app.deliveryPrefix);
    ctx.out.warn(`${stray.length} key(s) under ${ctx.env.app.deliveryPrefix} changed while it was replaced, such as ${stray[0] ?? ""}; replacing it again`);
    await sleepOf(ctx)(ctx.poll.delayMs ?? 1000);
  }
}

const DERIVED_SAMPLE = 20;

async function compareDerived(ctx: UpdateContext, backupId: string): Promise<RollbackResult["derived"]> {
  const recorded = new Map((await jsonl<DerivedEntry>(ctx, keys.derived(backupId))).map((entry) => [entry.key, entry]));
  const added = new Set<string>();
  const changed = new Set<string>();
  const seen = new Set<string>();
  for (const prefix of ctx.env.app.derivedPrefixes) {
    for (const info of await stableList(ctx.app, prefix, ctx.poll)) {
      seen.add(info.key);
      const entry = recorded.get(info.key);
      if (entry === undefined) added.add(info.key);
      else if (entry.etag !== info.etag || entry.size !== info.size) changed.add(info.key);
    }
  }
  const missing = [...recorded.keys()].filter((key) => !seen.has(key));
  return { added: [...added].sort(), changed: [...changed].sort(), missing: missing.sort() };
}

function derivedRecord(derived: RollbackResult["derived"]): DerivedReport {
  return { added: derived.added.length, changed: derived.changed.length, missing: derived.missing.length, keys: { added: derived.added.slice(0, DERIVED_SAMPLE), changed: derived.changed.slice(0, DERIVED_SAMPLE), missing: derived.missing.slice(0, DERIVED_SAMPLE) } };
}

async function stopAndSeal(ctx: UpdateContext): Promise<SealState> {
  const before = await ctx.target.status();
  if (before.state !== "stopped" || before.instances > 0) {
    const stop = await stopTarget(ctx);
    const seal = await ctx.steps.waitForSeal(ctx, stop.stoppedAt).catch((cause: unknown) => {
      ctx.out.warn(`the stopped replica could not be read: ${messageOf(cause)}`);
      return null;
    });
    await ctx.journal.record("seal", "done", seal === null ? { state: "unreadable" } : { state: seal.state, generation: seal.generation });
    return seal?.state ?? "unreadable";
  }
  await ctx.journal.record("stop", "skipped", { reason: "the app is stopped" });
  const seal = await readSeal(ctx).catch(() => null);
  const state = seal?.state ?? "unreadable";
  await ctx.journal.record("seal", state === "sealed" ? "skipped" : "done", seal === null ? { state } : { state, generation: seal.generation });
  return state;
}

async function restoreDroplet(ctx: UpdateContext, run: UpdateRun, recorded: RecordedConfiguration | null): Promise<boolean> {
  const wanted = run.previousDroplet ?? recorded?.droplet ?? null;
  if (wanted === null) {
    await ctx.journal.record("restore-droplet", "failed", { reason: "the run recorded no previous droplet" });
    ctx.out.error("the run recorded no previous droplet; the app stays stopped on the cutover state");
    return false;
  }
  if ((await ctx.target.currentDroplet()) === wanted) {
    await ctx.journal.record("restore-droplet", "skipped", { droplet: wanted });
    return true;
  }
  if ((await ctx.target.listDroplets()).some((d) => d.guid === wanted)) {
    await ctx.target.setDroplet(wanted);
    await ctx.journal.record("restore-droplet", "done", { droplet: wanted });
    return true;
  }
  const key = updateKeys.droplet(ctx.envName, run.runId, wanted);
  const bits = await ctx.backups.get(ctx.location + key);
  if (bits === null || ctx.target.restoreDroplet === undefined) {
    const reason = `droplet ${wanted} is gone and ${bits === null ? "no bits of it were saved" : "the target cannot upload droplet bits"}`;
    await ctx.journal.record("restore-droplet", "failed", { droplet: wanted, reason });
    ctx.out.error(`${reason}; the app stays stopped on the cutover state: deploy the previous release again and start it`);
    return false;
  }
  const file = ctx.workspace.path(`droplet-${wanted}`);
  writeFileSync(file, bits, { mode: 0o600 });
  const uploaded = await ctx.target.restoreDroplet(file);
  await ctx.target.setDroplet(uploaded);
  await ctx.journal.record("restore-droplet", "done", { droplet: uploaded, savedAs: key, replaces: wanted });
  return true;
}

async function firstSnapshotMarker(ctx: UpdateContext, promoted: string, nonce: string): Promise<{ generation: string; holds: boolean } | null> {
  const own = (await listGenerations(ctx.app, ctx.env.app.replicaPrefix)).find((g) => g.name > promoted && g.snapshot !== null);
  const data = own?.snapshot ? await ctx.app.get(own.snapshot.key) : null;
  if (own === undefined || data === null) return null;
  const file = ctx.workspace.path(`first-snapshot-${own.name}.db`);
  writeFileSync(file, data, { mode: 0o600 });
  return { generation: own.name, holds: holdsMarker(file, nonce) };
}

async function verifyPrevious(ctx: UpdateContext, promoted: Promoted, marker: string): Promise<Record<string, unknown>> {
  const ready = await ctx.target.probeReady();
  if (ready.outcome !== "ready") throw new OpsError(`the previous release started but its readiness answers ${ready.outcome}${ready.status === null ? "" : ` (${ready.status})`}`, 1, "target");
  const sleep = sleepOf(ctx);
  for (let i = 0; i < (ctx.poll.attempts ?? 30); i++) {
    if ((await acknowledgement(ctx.app, ctx.env.app.replicaPrefix, promoted, { ...ctx.poll, attempts: 1 })) === "applied") return { ready: ready.status, provenance: "applied", generation: promoted.generation };
    const own = await firstSnapshotMarker(ctx, promoted.generation, marker);
    if (own?.holds === true) return { ready: ready.status, provenance: "marker", generation: promoted.generation, ownGeneration: own.generation };
    if (own !== null) throw new OpsError(`the first snapshot the previous release wrote after ${promoted.generation} does not hold the marker row of this rollback, and no applied.json acknowledges the generation: it did not start from the promoted cutover state`, 1, ctx.env.app.replicaPrefix);
    await sleep(ctx.poll.delayMs ?? 1000);
  }
  throw new OpsError(`the previous release neither acknowledged generation ${promoted.generation} in applied.json nor wrote a first snapshot after it`, 1, ctx.env.app.replicaPrefix);
}

async function rollBackStopped(ctx: UpdateContext, run: UpdateRun, manifest: Manifest): Promise<RollbackResult> {
  const seal = await stopAndSeal(ctx);

  const dbFile = ctx.workspace.path(`rollback-${hex(4)}.db`);
  await downloadDb(ctx, manifest, dbFile);
  const sessionsDeleted = deleteSessions(dbFile);
  const marker = hex(16);
  writeMarker(dbFile, marker, run.runId, ctx.clock());
  const clock = await appClock(ctx);
  const promoted = await promote({ store: ctx.app, prefix: ctx.env.app.replicaPrefix, target: ctx.target, database: dbFile, origin: { kind: "restore", source: manifest.id }, serverNow: clock.now, skewMs: clock.skewMs, clock: ctx.clock, poll: ctx.poll });
  await ctx.journal.record("re-promote", "done", { generation: promoted.generation, nonce: promoted.nonce, sha256: promoted.sha256, sessionsDeleted, marker });

  const blobs = await jsonl<BlobEntry>(ctx, keys.blobs(manifest.id));
  const originalsRestored = await restoreOriginals(ctx, blobs, false);
  await ctx.journal.record("restore-originals", "done", { restored: originalsRestored });

  const delivery = await replaceDelivery(ctx, await jsonl<SiteEntry>(ctx, keys.site(manifest.id)), clock);
  const derived = await compareDerived(ctx, manifest.id);
  await ctx.journal.record("restore-delivery", "done", { written: delivery.written.length, removed: delivery.removed.length, relisted: delivery.relisted, derived: derivedRecord(derived) });
  const differing = [...derived.added, ...derived.changed, ...derived.missing];
  if (differing.length > 0) ctx.out.warn(`derived keys differ from the cutover backup ${manifest.id}: ${derived.added.length} added, ${derived.changed.length} changed, ${derived.missing.length} missing, such as ${differing.slice(0, 5).join(", ")}; the release renders them again`);

  const recorded = await recordedConfiguration(ctx, run.runId);
  let configuration: ConfigurationRestore = { set: [], removed: [], unchanged: [], unrestorable: [] };
  if (recorded === null) {
    ctx.out.warn(`run ${run.runId} recorded no configuration; the app keeps its current one`);
    await ctx.journal.record("restore-configuration", "skipped", { reason: "no recorded configuration" });
  } else {
    configuration = await ctx.target.restoreConfiguration(withoutMasks(recorded));
    await ctx.journal.record("restore-configuration", "done", { ...configuration });
    for (const name of configuration.unrestorable) ctx.out.warn(`${name} holds another value than when the update began; its old value is not known and was not restored`);
  }

  const result: RollbackResult = { ended: "stopped", generation: promoted.generation, seal, delivery, originalsRestored, configuration: { set: configuration.set, removed: configuration.removed, unrestorable: configuration.unrestorable }, derived };
  if (!(await restoreDroplet(ctx, run, recorded))) {
    await ctx.journal.record("start", "skipped", { reason: "no previous droplet to start" });
    await ctx.journal.record("rollback", "done", { ended: "stopped", generation: promoted.generation });
    return result;
  }

  await waitUntilStartable(ctx, promoted.at, clock);
  await ctx.journal.record("start", "started", { generation: promoted.generation });
  await startTarget(ctx);
  try {
    await ctx.journal.record("rollback-verify", "done", await verifyPrevious(ctx, promoted, marker));
  } catch (error) {
    await recordQuietly(ctx, "rollback-verify", "failed", { message: messageOf(error) });
    throw error;
  }
  if (await releaseUpdatePin(ctx, manifest.id, run.runId)) await ctx.journal.record("unpin", "done", { backupId: manifest.id });
  await ctx.journal.record("rollback", "done", { ended: "previous-release", generation: promoted.generation });
  return { ...result, ended: "previous-release" };
}

/**
 * Brings back the cutover state of deploy run `run`, in the order of `ROLLBACK_STEPS`, opened by a `rollback`
 * started record and closed by `rollback` done: stops the app if it runs and waits for the seal after STOPPED;
 * promotes the cutover backup's database again (before any old droplet can start); copies back originals whose
 * key holds other bytes; sets the delivery prefix to the backup's and lists it again until no key is newer than the
 * start of the replacement; checks the derived prefixes against the backup's ETag listing; restores the recorded
 * configuration verbatim, without a question (a recorded value that holds the redaction mask counts as unknown and
 * stays as it is); makes the previous droplet current (uploading its saved bits when it
 * was deleted); starts it and verifies it: readiness, and provenance through `applied.json` for a sealing runtime or
 * through the marker row in the first snapshot of an older one. Without a previous droplet or its bits the rollback
 * ends with the app stopped on the cutover state (`ended: "stopped"`); once the previous release runs verified, the
 * run's update pin on the cutover backup is released. A run that stopped the app but has no cutover
 * backup yet promoted nothing: its rollback makes the previous droplet current, starts it on the unchanged replica and
 * checks its readiness. It refuses instead while the app's current droplet is the one the run staged, or while the
 * newest generation carries an `origin.json` of kind `upgrade` that no `applied.json` acknowledges.
 */
export async function rollback(ctx: UpdateContext, run: UpdateRun, reason: RollbackReason): Promise<RollbackResult> {
  if (run.cutoverBackup === null) {
    if (run.promoted !== null) throw new OpsError(`run ${run.runId} records a promotion but no cutover backup to roll back to`, 1, "rollback");
    return restartPrevious(ctx, run, reason);
  }
  const manifest = await readManifest(ctx, run.cutoverBackup);
  if (manifest === null) throw new OpsError(`the cutover backup ${run.cutoverBackup} of run ${run.runId} does not exist or is incomplete`, 1, run.cutoverBackup);
  await ctx.journal.record("rollback", "started", { phase: "rollback", reason: reason.kind, ...(reason.kind === "automatic" ? { failure: reason.failure } : {}), cutoverBackup: manifest.id });
  try {
    return await rollBackStopped(ctx, run, manifest);
  } catch (error) {
    await recordQuietly(ctx, "rollback", "failed", { message: messageOf(error) });
    ctx.out.error(`the rollback of run ${run.runId} did not finish: ${messageOf(error)}; update resume runs it again from its first step`);
    throw error;
  }
}

async function promotedInPlace(ctx: UpdateContext, run: UpdateRun): Promise<string | null> {
  if (run.stagedDroplet !== null && (await ctx.target.currentDroplet()) === run.stagedDroplet) return `the app's current droplet is ${run.stagedDroplet}, the one run ${run.runId} staged`;
  const newest = (await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll)).at(-1);
  if (newest === undefined) return null;
  const read = async (marker: "origin" | "applied"): Promise<unknown> => {
    const data = await ctx.app.get(markerKey(ctx.env.app.replicaPrefix, newest.name, marker));
    return data === null ? null : parseJsonOrNull(data);
  };
  const origin = await read("origin");
  const kind: unknown = typeof origin === "object" && origin !== null ? Reflect.get(origin, "kind") : null;
  if (kind === "upgrade" && (await read("applied")) === null) return `the newest generation ${newest.name} was placed by an update and no release acknowledged it`;
  return null;
}

async function restartPrevious(ctx: UpdateContext, run: UpdateRun, reason: RollbackReason): Promise<RollbackResult> {
  await ctx.journal.record("rollback", "started", { phase: "rollback", reason: reason.kind, ...(reason.kind === "automatic" ? { failure: reason.failure } : {}), cutoverBackup: null });
  try {
    const promoted = await promotedInPlace(ctx, run);
    if (promoted !== null) throw new OpsError(`run ${run.runId} shows no cutover backup, but ${promoted}; the previous release does not start on it. Once the journal lists the cutover backup, update resume --env ${ctx.envName} --run ${run.runId} rolls back to it`, 1, "rollback");
    const seal = await stopAndSeal(ctx);
    const generation = (await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll)).at(-1)?.name ?? "";
    const recorded = await recordedConfiguration(ctx, run.runId);
    const result: RollbackResult = { ended: "stopped", generation, seal, delivery: { written: [], removed: [], relisted: 0 }, originalsRestored: [], configuration: { set: [], removed: [], unrestorable: [] }, derived: { added: [], changed: [], missing: [] } };
    if (!(await restoreDroplet(ctx, run, recorded))) {
      await ctx.journal.record("start", "skipped", { reason: "no previous droplet to start" });
      await ctx.journal.record("rollback", "done", { ended: "stopped", generation });
      return result;
    }
    await ctx.journal.record("start", "started", { generation, reason: "nothing was promoted" });
    await startTarget(ctx);
    const ready = await ctx.target.probeReady();
    if (ready.outcome !== "ready") throw new OpsError(`the previous release started but its readiness answers ${ready.outcome}${ready.status === null ? "" : ` (${ready.status})`}`, 1, "target");
    await ctx.journal.record("rollback-verify", "done", { ready: ready.status, provenance: "unchanged", generation });
    await ctx.journal.record("rollback", "done", { ended: "previous-release", generation });
    return { ...result, ended: "previous-release" };
  } catch (error) {
    await recordQuietly(ctx, "rollback", "failed", { message: messageOf(error) });
    ctx.out.error(`the rollback of run ${run.runId} did not finish: ${messageOf(error)}; update resume runs it again from its first step`);
    throw error;
  }
}

async function outcome(ctx: UpdateContext, runId: string, exitCode: UpdateExitCode, message: string, fallback: UpdateRunState): Promise<UpdateOutcome> {
  const run = await readUpdateRun(ctx, runId).catch(() => null);
  return { exitCode, runId, state: run?.state ?? fallback, message, report: run === null ? { runId, steps: [], downtimeMs: null } : reportOf(run) };
}

const ROLLBACK_FROM: ReadonlySet<UpdateRunState> = new Set(["down", "verifying", "halted", "verified", "accepted", "rolling-back"]);

async function liveLoss(ctx: UpdateContext, manifest: Manifest): Promise<LossReport | null> {
  try {
    const newest = (await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll)).at(-1);
    if (newest === undefined) return null;
    const current = ctx.workspace.path("current.db");
    await buildDatabase(ctx.app, ctx.env.app.replicaPrefix, await completeGeneration(ctx.app, ctx.env.app.replicaPrefix, newest, ctx.poll), current);
    const cutover = ctx.workspace.path("cutover.db");
    await downloadDb(ctx, manifest, cutover);
    return lossReport(current, cutover, manifest.source.lastFrameAt ?? manifest.createdAt);
  } catch (cause) {
    ctx.out.warn(`the current database could not be read for the loss report: ${messageOf(cause)}`);
    return null;
  }
}

function lossLines(loss: LossReport | null, since: number): string[] {
  if (loss === null) return ["what the rollback discards cannot be listed: the current database could not be read"];
  const lines = [`changes since ${new Date(since).toISOString()} that the rollback discards or reverts:`];
  for (const [table, d] of Object.entries(loss.tables)) lines.push(`  ${table}: ${d.added} newer row(s) dropped, ${d.changed} changed row(s) reverted, ${d.removed} deleted row(s) back`);
  if (loss.auditEntriesAfter > 0) lines.push(`  audit entries after the cutover: ${loss.auditEntriesAfter}`);
  const a = loss.access;
  lines.push(`access changes: ${hasAccessChanges(loss) ? "" : "none"}`);
  for (const [label, users] of [["created", a.created], ["deleted", a.deleted], ["deactivated", a.deactivated], ["roles changed", a.rolesChanged], ["second factor reset", a.mfaReset]] as const) if (users.length > 0) lines.push(`  ${label}: ${users.join(", ")}`);
  return lines;
}

async function typedName(ctx: UpdateContext, text: string): Promise<string | null> {
  const given = ctx.answers.answers["rollback-accepted"];
  if (given !== undefined) return given.trim();
  if (ctx.answers.prompt === undefined) return null;
  return (await ctx.answers.prompt(`${text}\nType the environment's name to roll back (rollback-accepted): `)).trim();
}

/**
 * `update rollback`: rolls deploy run `run` back on request. Before `accept` it is lossless and asks nothing more; after
 * `accept` it shows the loss report and needs the environment's name as the answer to `rollback-accepted`. Exit 0 once
 * the previous release runs verified, 1 when the rollback could not finish.
 */
export async function rollbackCommand(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  if (!ROLLBACK_FROM.has(run.state) || run.cutoverBackup === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `run ${run.runId} is ${run.state}${run.cutoverBackup === null ? " without a cutover backup" : ""}; there is nothing to roll back${run.state === "deploying" || run.state === "down" ? " (update abort ends a run before its cutover backup)" : ""}`, run.state);
  const manifest = await readManifest(ctx, run.cutoverBackup);
  if (manifest === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `the cutover backup ${run.cutoverBackup} of run ${run.runId} does not exist or is incomplete`, run.state);
  const acceptRecord = run.records.filter((r) => r.step === "accept" && r.state === "done").at(-1);
  if (acceptRecord !== undefined) {
    const accepted = acceptRecord.at;
    const lines = [`run ${run.runId} was accepted ${new Date(accepted).toISOString()}; rolling back discards everything written since the cutover backup ${manifest.id}`, ...lossLines(await liveLoss(ctx, manifest), manifest.source.lastFrameAt ?? manifest.createdAt), "every login session ends; everyone signs in again"];
    for (const line of lines) ctx.out.info(line);
    const name = await typedName(ctx, lines.join("\n"));
    if (name !== ctx.envName) {
      const message = name === null ? `stopped: "rollback-accepted" needs the environment's name ${ctx.envName} as its answer ("rollback-accepted": "${ctx.envName}" in --answers; --yes does not answer it)` : `stopped: "rollback-accepted" was answered with "${name}", not the environment's name`;
      return outcome(ctx, run.runId, UPDATE_EXIT.refused, message, run.state);
    }
    let stopped = false;
    try {
      const stop = await stopTarget(ctx);
      stopped = stop.wasRunning;
      const seal = await ctx.steps.waitForSeal(ctx, stop.stoppedAt);
      await acceptSeal(ctx, seal, stop.stoppedAt);
      const safety = await createBackup(ctx, { kind: "pre-restore", mode: { kind: "stopped", seal, stoppedAt: stop.stoppedAt }, pinFor: ctx.runId });
      ctx.out.info(`pre-restore backup ${safety.id} written and verified`);
    } catch (error) {
      const restarted = stopped ? await startTarget(ctx).then(() => true, () => false) : false;
      const message = `the rollback stopped before it changed the store: ${messageOf(error)}${stopped ? (restarted ? "; the app was started again" : "; the app stays stopped and starting it again failed") : ""}`;
      return outcome(ctx, run.runId, UPDATE_EXIT.refused, message, run.state);
    }
  }
  try {
    const result = await ctx.steps.rollback(ctx, run, { kind: "requested" });
    if (result.ended === "stopped") return outcome(ctx, run.runId, UPDATE_EXIT.refused, `the cutover state is back, but no previous droplet was left to start; the app stays stopped`, "rolled-back");
    return outcome(ctx, run.runId, UPDATE_EXIT.done, `rolled back to the cutover backup ${manifest.id}; the previous release runs on generation ${result.generation}`, "rolled-back");
  } catch (error) {
    return outcome(ctx, run.runId, UPDATE_EXIT.refused, `the rollback did not finish: ${messageOf(error)}; run update resume`, "rolling-back");
  }
}
