import { readManifest } from "../backup.ts";
import { messageOf } from "../context.ts";
import { readUpdateRun, reportOf, retirePending, RUN_STEP } from "./journal.ts";
import { finishStartedRollback, guardRollback, startedPrevious, type StartedPrevious } from "./rollback.ts";
import { stoppedAfterRollback } from "./status.ts";
import { retireStep, verifyCommand } from "./verify.ts";
import { UPDATE_EXIT, type RollbackReason, type UpdateContext, type UpdateExitCode, type UpdateOutcome, type UpdateRecord, type UpdateRun, type UpdateRunState } from "./types.ts";
import { fixedText, literal } from "../redact.ts";

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
    if (result.ended === "stopped") return outcome(ctx, run.runId, UPDATE_EXIT.refused, stoppedAfterRollback(ctx, fixedText`the rollback of run ${literal(run.runId)} ran again`, run.versions?.from ?? null), "rolled-back");
    return outcome(ctx, run.runId, reason.kind === "automatic" ? UPDATE_EXIT.rolledBack : UPDATE_EXIT.done, fixedText`rolled back: the previous release runs on generation ${literal(result.generation)}`, "rolled-back");
  } catch (error) {
    return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`the rollback did not finish: ${messageOf(error)}; run update resume again`, "rolling-back");
  }
}

async function finishOrGuard(ctx: UpdateContext, run: UpdateRun, started: StartedPrevious, reason: RollbackReason): Promise<UpdateOutcome> {
  const scope = fixedText`--env ${literal(ctx.envName)} --run ${literal(run.runId)}`;
  try {
    const finished = await finishStartedRollback(ctx, run, started);
    if (finished !== null) {
      if (reason.kind === "abort") await ctx.journal.record("abort", "done", { phase: "abort", promoted: true, ended: finished.ended });
      return outcome(ctx, run.runId, reason.kind === "automatic" ? UPDATE_EXIT.rolledBack : UPDATE_EXIT.done, fixedText`rolled back: the previous release runs verified on generation ${literal(finished.generation)}`, "rolled-back");
    }
  } catch (error) {
    return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`the previous release runs on generation ${literal(started.generation)} since the rollback started it, but it could not be verified: ${messageOf(error)}; update resume ${scope} verifies it again, update rollback ${scope} rolls back again and asks before it discards what the previous release wrote`, "rolling-back");
  }
  const refused = await guardAgain(ctx, run);
  if (refused !== null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`not rolled back again: ${refused}; run update resume ${scope} again with the answer`, run.state);
  return rollBackAgain(ctx, run, reason);
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
  if (manifest === null) return fixedText`the cutover backup ${literal(run.cutoverBackup)} does not exist or is incomplete`;
  const guarded = await guardRollback(ctx, run, manifest, "ask");
  return guarded.ok ? null : guarded.message;
}

/**
 * `update resume`: continues an interrupted run where its journal ended, after a `resume` record. A deploy continues
 * through `continueDeploy`; a rollback that did not finish runs again from its first step (every rollback step can be
 * repeated) unless it already started the previous release on the generation it promoted: while the app runs that
 * release's droplet, only its verification runs again (`finishStartedRollback`), and a failed verification refuses with
 * the release left running; otherwise the rollback runs again through `guardRollback` in mode `ask`, which compares
 * the stopped replica with that generation. A run whose verification failed before its rollback began is rolled back through `guardRollback` in mode
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
  if (action === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`run ${literal(run.runId)} is ${literal(run.state)}; there is nothing to resume${run.state === "rolling-back" ? literal(" (no rollback began; update rollback starts one)") : literal("")}`, run.state);
  await ctx.journal.record("resume", "started", { phase: "resume", state: run.state, lastDone: run.lastDone });
  switch (action) {
    case "rollback": {
      const reason: RollbackReason = begun === undefined ? { kind: "automatic", failure: "verification failed" } : reasonOf(begun);
      const started = startedPrevious(run);
      return started === null ? rollBackAgain(ctx, run, reason) : finishOrGuard(ctx, run, started, reason);
    }
    case "rollback-failed-verify":
    case "rollback-failed-step": {
      const refused = await guardAgain(ctx, run);
      if (refused !== null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`not rolled back: ${refused}; run update resume --env ${literal(ctx.envName)} --run ${literal(run.runId)} again with the answer`, run.state);
      return rollBackAgain(ctx, run, { kind: "automatic", failure: failedStep ?? "verification failed" });
    }
    case "verify":
      if (run.promoted === null) return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`run ${literal(run.runId)} is halted without a recorded promotion; run update rollback or update abort`, run.state);
      return verifyCommand(ctx, run);
    case "deploy":
      return ctx.steps.continueDeploy(ctx, run);
    case "retire": {
      const retired = await retireStep(ctx, run, true);
      if (!retired.ok) return outcome(ctx, run.runId, UPDATE_EXIT.refused, fixedText`retiring the previous releases failed again: ${retired.error}; their droplets can still be started by the platform; run update resume once the target answers`, run.state);
      return outcome(ctx, run.runId, UPDATE_EXIT.done, fixedText`the previous releases of run ${literal(run.runId)} are retired`, run.state);
    }
  }
}
