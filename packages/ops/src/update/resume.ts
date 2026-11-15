import { readManifest } from "../backup.ts";
import { messageOf } from "../context.ts";
import { readUpdateRun, reportOf, retirePending, RUN_STEP } from "./journal.ts";
import { guardRollback } from "./rollback.ts";
import { stoppedAfterRollback } from "./status.ts";
import { retireStep, verifyCommand } from "./verify.ts";
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
    if (result.ended === "stopped") return outcome(ctx, run.runId, UPDATE_EXIT.refused, stoppedAfterRollback(ctx, `the rollback of run ${run.runId} ran again`, run.versions?.from ?? null), "rolled-back");
    return outcome(ctx, run.runId, reason.kind === "automatic" ? UPDATE_EXIT.rolledBack : UPDATE_EXIT.done, `rolled back: the previous release runs on generation ${result.generation}`, "rolled-back");
  } catch (error) {
    return outcome(ctx, run.runId, UPDATE_EXIT.refused, `the rollback did not finish: ${messageOf(error)}; run update resume again`, "rolling-back");
  }
}

function failedAfterStop(run: UpdateRun): string | null {
  if (run.state !== "down" && run.state !== "verifying") return null;
  const last = run.records.filter((r) => r.phase === "deploy" && r.step !== RUN_STEP && r.step !== "run-done" && r.step !== "run-failed").at(-1);
  if (last === undefined || last.state !== "failed" || last.step === "stop") return null;
  return `${last.step}: ${typeof last.data.error === "string" ? last.data.error : "failed"}`;
}

async function guardAgain(ctx: UpdateContext, run: UpdateRun): Promise<string | null> {
  if (run.cutoverBackup === null) return null;
  const manifest = await readManifest(ctx, run.cutoverBackup);
  if (manifest === null) return `the cutover backup ${run.cutoverBackup} does not exist or is incomplete`;
  const guarded = await guardRollback(ctx, run, manifest, "ask");
  return guarded.ok ? null : guarded.message;
}

/**
 * `update resume`: continues an interrupted run where its journal ended, after a `resume` record. A deploy continues
 * through `continueDeploy`; a rollback that did not finish runs again from its first step (every rollback step can be
 * repeated); a run whose verification failed before its rollback began is rolled back through `guardRollback` in mode
 * `ask`, since its new release may have served since: the stop first, the `rollback-accepted` question when it wrote,
 * and a `pre-restore` backup; so is a deploy whose last step after the stop failed before its automatic rollback
 * began; a halted run is verified again. The ending is that of
 * the step it continued: exit 0 verified, 3 rolled back, 1 halted or refused. A verified or accepted run whose retire
 * of the previous releases did not end (`retirePending`) retires them again: exit 0 once they are, 1 otherwise. A rollback that began only as a command
 * refused after `accept` is not resumed.
 */
export async function resume(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  const since = afterLastAccept(run);
  const begun = since.filter((r) => r.step === "rollback" && r.state === "started").at(-1);
  const verifyFailed = since.some((r) => r.step === "verify" && r.state === "done" && (r.phase === "deploy" || r.phase === "verify") && r.data.verdict === "failed");
  const accepted = since.length < run.records.length;
  const failedStep = failedAfterStop(run);
  const action = retirePending(run) ? "retire" : run.state === "rolling-back" ? (begun !== undefined ? "rollback" : verifyFailed && !accepted ? "rollback-failed-verify" : null) : run.state === "halted" ? "verify" : failedStep !== null ? "rollback-failed-step" : run.state === "deploying" || run.state === "down" || run.state === "verifying" ? "deploy" : null;
  if (action === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `run ${run.runId} is ${run.state}; there is nothing to resume${run.state === "rolling-back" ? " (no rollback began; update rollback starts one)" : ""}`, run.state);
  await ctx.journal.record("resume", "started", { phase: "resume", state: run.state, lastDone: run.lastDone });
  switch (action) {
    case "rollback":
      return rollBackAgain(ctx, run, begun === undefined ? { kind: "automatic", failure: "verification failed" } : reasonOf(begun));
    case "rollback-failed-verify":
    case "rollback-failed-step": {
      const refused = await guardAgain(ctx, run);
      if (refused !== null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `not rolled back: ${refused}; run update resume --env ${ctx.envName} --run ${run.runId} again with the answer`, run.state);
      return rollBackAgain(ctx, run, { kind: "automatic", failure: failedStep ?? "verification failed" });
    }
    case "verify":
      if (run.promoted === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `run ${run.runId} is halted without a recorded promotion; run update rollback or update abort`, run.state);
      return verifyCommand(ctx, run);
    case "deploy":
      return ctx.steps.continueDeploy(ctx, run);
    case "retire": {
      const retired = await retireStep(ctx, run, true);
      if (!retired.ok) return outcome(ctx, run.runId, UPDATE_EXIT.refused, `retiring the previous releases failed again: ${retired.error}; their droplets can still be started by the platform; run update resume once the target answers`, run.state);
      return outcome(ctx, run.runId, UPDATE_EXIT.done, `the previous releases of run ${run.runId} are retired`, run.state);
    }
  }
}
