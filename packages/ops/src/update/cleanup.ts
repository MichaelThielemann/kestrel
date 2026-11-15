import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { readManifest } from "../backup.ts";
import { messageOf, recordQuietly } from "../context.ts";
import { fromJsonl, jsonBytes, keys, type BlobEntry } from "../layout.ts";
import { confirm } from "../questions.ts";
import { buildDatabase, completeGeneration, stableGenerations } from "../replica.ts";
import { referencedBlobs } from "../sqlite.ts";
import { stableList } from "../store.ts";
import { listUpdateRuns, readUpdateRun, reportOf } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { UPDATE_EXIT, type UpdateContext, type UpdateExitCode, type UpdateOutcome, type UpdateRun, type UpdateRunState } from "./types.ts";
import { fixedText, literal } from "../redact.ts";

/** Options of {@link cleanup}. */
export interface CleanupOptions {
  /** List what cleanup would remove without removing it. */
  dryRun: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function outcome(ctx: UpdateContext, runId: string, exitCode: UpdateExitCode, message: string, fallback: UpdateRunState): Promise<UpdateOutcome> {
  const run = await readUpdateRun(ctx, runId).catch(() => null);
  return { exitCode, runId, state: run?.state ?? fallback, message, report: run === null ? { runId, steps: [], downtimeMs: null } : reportOf(run) };
}

async function orphans(ctx: UpdateContext, cutover: string): Promise<BlobEntry[]> {
  const prefix = ctx.env.app.replicaPrefix;
  const newest = (await stableGenerations(ctx.app, prefix, ctx.poll)).at(-1);
  if (newest === undefined) throw new Error(`the replica under ${prefix} has no generation`);
  const file = ctx.workspace.path("cleanup-current.db");
  await buildDatabase(ctx.app, prefix, await completeGeneration(ctx.app, prefix, newest, ctx.poll), file);
  const referenced = new Set(referencedBlobs(file, ctx.env.app.media).map((ref) => ref.key));
  const data = await ctx.backups.get(ctx.location + keys.blobs(cutover));
  if (data === null) throw new Error(`blobs.jsonl of the cutover backup ${cutover} is missing`);
  const held = boundaryCast<BlobEntry[]>(fromJsonl(data), "json");
  const live = new Map((await stableList(ctx.app, ctx.env.app.mediaPrefix, ctx.poll)).map((info) => [info.key, info]));
  const objects = new Map((await stableList(ctx.backups, `${ctx.location}objects/`, ctx.poll)).map((info) => [info.key, info]));
  return held.filter((entry) => {
    const info = live.get(entry.key);
    const copy = objects.get(ctx.location + entry.object);
    return !referenced.has(entry.key) && info !== undefined && info.etag === entry.etag && copy !== undefined && copy.size === entry.size;
  });
}

/** Deletes the droplet bits run `runId` saved into the backup location and resolves to their keys. */
export async function removeSavedDroplets(ctx: Pick<UpdateContext, "backups" | "location" | "envName" | "poll">, runId: string): Promise<string[]> {
  const saved = (await stableList(ctx.backups, ctx.location + updateKeys.droplets(ctx.envName, runId), ctx.poll)).map((info) => info.key);
  for (const key of saved) await ctx.backups.delete(key);
  return saved;
}

/** Releases the update pin of run `runId` on backup `backupId`, if it holds one; prune then treats the backup like any other. */
export async function releaseUpdatePin(ctx: Pick<UpdateContext, "backups" | "location" | "clock">, backupId: string, runId: string): Promise<boolean> {
  if ((await ctx.backups.head(ctx.location + updateKeys.pin(backupId, runId))) === null) return false;
  const released = ctx.location + updateKeys.unpin(backupId, runId);
  if ((await ctx.backups.head(released)) === null) await ctx.backups.put(released, jsonBytes({ runId, at: ctx.clock() }), { contentType: "application/json" });
  return true;
}

/** True while run `run` holds an update pin on its cutover backup that no release record cancels. */
export async function holdsUpdatePin(ctx: Pick<UpdateContext, "backups" | "location">, run: Pick<UpdateRun, "runId" | "cutoverBackup">): Promise<boolean> {
  if (run.cutoverBackup === null) return false;
  if ((await ctx.backups.head(ctx.location + updateKeys.pin(run.cutoverBackup, run.runId))) === null) return false;
  return (await ctx.backups.head(ctx.location + updateKeys.unpin(run.cutoverBackup, run.runId))) === null;
}

async function pinnedElsewhere(ctx: UpdateContext, runId: string): Promise<string> {
  const held: string[] = [];
  for (const entry of await listUpdateRuns(ctx, ctx.envName)) {
    if (entry.command !== "update deploy" || entry.runId === runId) continue;
    const other = await readUpdateRun(ctx, entry.runId);
    if (other.state === "accepted" && (await holdsUpdatePin(ctx, other))) held.push(fixedText`kestrel update cleanup --env ${literal(ctx.envName)} --run ${literal(other.runId)}`);
  }
  return held.length === 0 ? "" : `; accepted runs that still pin their cutover backup: ${held.join(", ")}`;
}

/**
 * `update cleanup`: ends an accepted deploy run at least `update.cleanupAfterDays` after its `accept`. Steps
 * `cleanup-check` (refuses before that, or for a run that is not accepted, naming the accepted runs that still pin
 * their cutover backup), `cleanup-delete` (originals under the media
 * prefix that no row of the current replica references and that the cutover backup holds, after the `cleanup-delete`
 * answer) and `unpin` (releases the update pin of the cutover backup, so prune treats it like any other, and deletes
 * the droplet bits the run saved). An original
 * whose live bytes differ from the cutover backup's copy, or whose copy is gone, stays.
 */
export async function cleanup(ctx: UpdateContext, run: UpdateRun, options: CleanupOptions): Promise<UpdateOutcome> {
  const accept = run.records.filter((r) => r.step === "accept" && r.state === "done").at(-1);
  if (run.state !== "accepted" || accept === undefined) return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`run ${literal(run.runId)} is ${literal(run.state)}; cleanup needs an accepted run${await pinnedElsewhere(ctx, run.runId)}`, run.state);
  const earliest = accept.at + ctx.update.cleanupAfterDays * DAY_MS;
  if (ctx.clock() < earliest) return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`run ${literal(run.runId)} was accepted ${new Date(accept.at).toISOString()}; cleanup runs ${ctx.update.cleanupAfterDays} day(s) after that, from ${new Date(earliest).toISOString()}`, run.state);
  const cutover = run.cutoverBackup;
  if (cutover === null || (await readManifest(ctx, cutover)) === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`the cutover backup ${literal(cutover ?? "(none)")} of run ${literal(run.runId)} does not exist or is incomplete; cleanup deletes nothing it cannot bring back`, run.state);
  let candidates: BlobEntry[];
  try {
    candidates = await orphans(ctx, cutover);
  } catch (error) {
    return outcome(ctx, run.runId, UPDATE_EXIT.refused, `cleanup cannot tell which originals are unreferenced: ${messageOf(error)}`, run.state);
  }
  const bytes = candidates.reduce((n, entry) => n + entry.size, 0);
  const summary = fixedText`${candidates.length} original(s), ${(bytes / 1024 / 1024).toFixed(1)} MiB, that no row references and the cutover backup ${literal(cutover)} holds`;
  ctx.out.info(`cleanup ${options.dryRun ? "would delete" : "deletes"} ${summary}`);
  for (const entry of candidates.slice(0, 20)) ctx.out.info(`  ${entry.key}`);
  if (options.dryRun) return outcome(ctx, run.runId, UPDATE_EXIT.done, `dry run: ${summary}`, run.state);
  await ctx.journal.record("cleanup-check", "done", { phase: "cleanup", acceptedAt: accept.at, earliest, candidates: candidates.length, bytes });
  try {
    if (candidates.length > 0) await confirm(ctx.answers, "cleanup-delete", `delete ${summary}`);
    for (const entry of candidates) await ctx.app.delete(entry.key);
    await ctx.journal.record("cleanup-delete", "done", { deleted: candidates.map((entry) => entry.key) });
  } catch (error) {
    await recordQuietly(ctx, "cleanup-delete", "failed", { message: messageOf(error) });
    return outcome(ctx, run.runId, UPDATE_EXIT.refused, messageOf(error), run.state);
  }
  await releaseUpdatePin(ctx, cutover, run.runId);
  const bits = await removeSavedDroplets(ctx, run.runId);
  await ctx.journal.record("unpin", "done", { backupId: cutover, droplets: bits.length });
  return outcome(ctx, run.runId, UPDATE_EXIT.done, fixedText`cleaned: deleted ${candidates.length} original(s); the cutover backup ${literal(cutover)} is no longer pinned`, "cleaned");
}
