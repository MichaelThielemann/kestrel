import { readManifest } from "../backup.ts";
import { messageOf, recordQuietly, startTarget } from "../context.ts";
import { stableGenerations } from "../replica.ts";
import { releaseUpdatePin } from "./cleanup.ts";
import { guardRollback } from "./rollback.ts";
import { readUpdateRun, reportOf } from "./journal.ts";
import { OPEN_STATES, UPDATE_EXIT, type UpdateContext, type UpdateExitCode, type UpdateOutcome, type UpdateRun, type UpdateRunState } from "./types.ts";

async function outcome(ctx: UpdateContext, runId: string, exitCode: UpdateExitCode, message: string, fallback: UpdateRunState): Promise<UpdateOutcome> {
  const run = await readUpdateRun(ctx, runId).catch(() => null);
  return { exitCode, runId, state: run?.state ?? fallback, message, report: run === null ? { runId, steps: [], downtimeMs: null } : reportOf(run) };
}

async function placedAfterCutover(ctx: UpdateContext, run: UpdateRun): Promise<boolean> {
  if (run.cutoverBackup === null) return false;
  const manifest = await readManifest(ctx, run.cutoverBackup);
  const source = manifest?.source.generation ?? null;
  if (source === null) return true;
  return (await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll)).some((g) => g.name > source);
}

/**
 * `update abort`: ends an open run without finishing it. Before the promotion it starts the previous release again on
 * the unchanged replica, releases the run's update pin on its cutover backup and records `abort` with `promoted: false`; after the promotion it rolls back first
 * (`RollbackReason` `abort`), so the old droplet never starts on a converted generation; once the new release started,
 * that rollback goes through `guardRollback` like `update rollback`: the stop first, the question when the new release
 * wrote since its start, and a verified `pre-restore` backup. A generation newer than the
 * cutover backup's source counts as promoted even when the journal did not record the promotion.
 */
export async function abort(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  if (!OPEN_STATES.has(run.state)) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `run ${run.runId} is ${run.state}, not open; there is nothing to abort`, run.state);
  const promoted = run.promoted !== null || (await placedAfterCutover(ctx, run));
  if (promoted && run.cutoverBackup !== null) {
    const manifest = await readManifest(ctx, run.cutoverBackup);
    if (manifest === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `the cutover backup ${run.cutoverBackup} of run ${run.runId} does not exist or is incomplete`, run.state);
    const guarded = await guardRollback(ctx, run, manifest, "ask");
    if (!guarded.ok) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `not aborted: ${guarded.message}`, run.state);
  }
  await ctx.journal.record("abort", "started", { phase: "abort", state: run.state });
  if (promoted) {
    try {
      const result = await ctx.steps.rollback(ctx, run, { kind: "abort" });
      await ctx.journal.record("abort", "done", { phase: "abort", promoted: true, ended: result.ended });
      if (result.ended === "stopped") return outcome(ctx, run.runId, UPDATE_EXIT.refused, "the cutover state is promoted again, but no previous droplet was left to start; the app stays stopped", "rolled-back");
      return outcome(ctx, run.runId, UPDATE_EXIT.done, `aborted: the cutover state is promoted again and the previous release runs on generation ${result.generation}`, "rolled-back");
    } catch (error) {
      await recordQuietly(ctx, "abort", "failed", { phase: "abort", promoted: true, message: messageOf(error) });
      return outcome(ctx, run.runId, UPDATE_EXIT.refused, `the abort did not finish its rollback: ${messageOf(error)}; run update resume`, "rolling-back");
    }
  }
  try {
    const status = await ctx.target.status();
    if (status.state !== "started") {
      const current = await ctx.target.currentDroplet();
      if (run.previousDroplet !== null && current !== run.previousDroplet) {
        await ctx.target.setDroplet(run.previousDroplet);
        await ctx.journal.record("restore-droplet", "done", { droplet: run.previousDroplet });
      }
      await ctx.journal.record("start", "started", { reason: "abort before the promotion" });
      await startTarget(ctx);
    }
  } catch (error) {
    await recordQuietly(ctx, "abort", "failed", { phase: "abort", promoted: false, message: messageOf(error) });
    return outcome(ctx, run.runId, UPDATE_EXIT.refused, `the abort could not start the previous release: ${messageOf(error)}`, run.state);
  }
  if (run.cutoverBackup !== null && (await releaseUpdatePin(ctx, run.cutoverBackup, run.runId))) await recordQuietly(ctx, "unpin", "done", { backupId: run.cutoverBackup });
  await ctx.journal.record("abort", "done", { phase: "abort", promoted: false });
  return outcome(ctx, run.runId, UPDATE_EXIT.done, "aborted before the promotion: the previous release runs on the unchanged replica", "aborted");
}
