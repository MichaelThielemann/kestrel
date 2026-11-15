import { messageOf } from "../context.ts";
import { readUpdateRun, reportOf } from "./journal.ts";
import { UPDATE_EXIT, type RollbackReason, type UpdateContext, type UpdateExitCode, type UpdateOutcome, type UpdateRecord, type UpdateRun, type UpdateRunState } from "./types.ts";

async function outcome(ctx: UpdateContext, runId: string, exitCode: UpdateExitCode, message: string, fallback: UpdateRunState): Promise<UpdateOutcome> {
  const run = await readUpdateRun(ctx, runId).catch(() => null);
  return { exitCode, runId, state: run?.state ?? fallback, message, report: run === null ? { runId, steps: [], downtimeMs: null } : reportOf(run) };
}

const afterLastAccept = (run: UpdateRun): UpdateRecord[] => {
  const accepted = run.records.map((r) => r.step === "accept" && r.state === "done").lastIndexOf(true);
  return run.records.slice(accepted + 1);
};

function reasonOf(record: UpdateRecord): RollbackReason {
  const kind = record.data.reason;
  if (kind === "requested") return { kind: "requested" };
  if (kind === "abort") return { kind: "abort" };
  return { kind: "automatic", failure: typeof record.data.failure === "string" ? record.data.failure : "the deploy failed after the stop" };
}

async function rollBackAgain(ctx: UpdateContext, run: UpdateRun, reason: RollbackReason): Promise<UpdateOutcome> {
  try {
    const result = await ctx.steps.rollback(ctx, run, reason);
    if (reason.kind === "abort") await ctx.journal.record("abort", "done", { phase: "abort", promoted: true, ended: result.ended });
    if (result.ended === "stopped") return outcome(ctx, run.runId, UPDATE_EXIT.refused, "the cutover state is promoted again, but no previous droplet was left to start; the app stays stopped", "rolled-back");
    return outcome(ctx, run.runId, reason.kind === "automatic" ? UPDATE_EXIT.rolledBack : UPDATE_EXIT.done, `rolled back: the previous release runs on generation ${result.generation}`, "rolled-back");
  } catch (error) {
    return outcome(ctx, run.runId, UPDATE_EXIT.refused, `the rollback did not finish: ${messageOf(error)}; run update resume again`, "rolling-back");
  }
}

async function verifyAgain(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  if (run.promoted === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `run ${run.runId} is halted without a recorded promotion; run update rollback or update abort`, run.state);
  const started = run.records.filter((r) => r.phase === "deploy" && r.step === "start").at(-1);
  const result = await ctx.steps.verify(ctx, { promoted: run.promoted, startedAt: started?.at ?? run.startedAt });
  await ctx.journal.record("verify", "done", { phase: "verify", verdict: result.verdict, checks: result.checks, ownGeneration: result.ownGeneration });
  if (result.verdict === "unverifiable") return outcome(ctx, run.runId, UPDATE_EXIT.refused, `verification still cannot tell (readiness ${result.ready.outcome}); the new release keeps running`, "halted");
  const now = await readUpdateRun(ctx, run.runId);
  if (result.verdict === "failed") {
    const failed = result.checks.filter((c) => c.hard && !c.ok).map((c) => c.name);
    return rollBackAgain(ctx, now, { kind: "automatic", failure: `verification failed${failed.length > 0 ? `: ${failed.join(", ")}` : ""}` });
  }
  const retired = await ctx.steps.retire(ctx, now);
  await ctx.journal.record("retire", "done", { droplets: retired.droplets, revisions: retired.revisions, savedDroplet: retired.savedDroplet });
  return outcome(ctx, run.runId, UPDATE_EXIT.done, "verified: the new release passed", "verified");
}

/**
 * `update resume`: continues an interrupted run where its journal ended, after a `resume` record. A deploy continues
 * through `continueDeploy`; a rollback that did not finish runs again from its first step (every rollback step can be
 * repeated); a run whose verification failed is rolled back; a halted run is verified again. The ending is that of
 * the step it continued: exit 0 verified, 3 rolled back, 1 halted or refused. A rollback that began only as a command
 * refused after `accept` is not resumed.
 */
export async function resume(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  const since = afterLastAccept(run);
  const begun = since.filter((r) => r.step === "rollback" && r.state === "started").at(-1);
  const verifyFailed = since.some((r) => r.step === "verify" && r.state === "done" && (r.phase === "deploy" || r.phase === "verify") && r.data.verdict === "failed");
  const accepted = since.length < run.records.length;
  const action = run.state === "rolling-back" ? (begun !== undefined ? "rollback" : verifyFailed && !accepted ? "rollback-failed-verify" : null) : run.state === "halted" ? "verify" : run.state === "deploying" || run.state === "down" || run.state === "verifying" ? "deploy" : null;
  if (action === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `run ${run.runId} is ${run.state}; there is nothing to resume${run.state === "rolling-back" ? " (no rollback began; update rollback starts one)" : ""}`, run.state);
  await ctx.journal.record("resume", "started", { phase: "resume", state: run.state, lastDone: run.lastDone });
  switch (action) {
    case "rollback":
      return rollBackAgain(ctx, run, begun === undefined ? { kind: "automatic", failure: "verification failed" } : reasonOf(begun));
    case "rollback-failed-verify":
      return rollBackAgain(ctx, run, { kind: "automatic", failure: "verification failed" });
    case "verify":
      return verifyAgain(ctx, run);
    case "deploy":
      return ctx.steps.continueDeploy(ctx, run);
  }
}
