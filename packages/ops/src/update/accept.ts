import { readUpdateRun, reportOf, retirePending } from "./journal.ts";
import { retireStep } from "./verify.ts";
import { UPDATE_EXIT, type UpdateContext, type UpdateOutcome, type UpdateRun } from "./types.ts";
import { fixedText, literal } from "../redact.ts";

/**
 * Accepts a `verified` deploy run: records `accept`, after which a rollback discards what was written since and needs
 * the `rollback-accepted` answer. A pinned cutover backup stays pinned until `update cleanup`. Refuses with exit 1
 * for a run in any other state. When the retire of the previous releases after its verification did not end, it
 * retires them first and refuses with exit 1 while that fails.
 */
export async function accept(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  if (run.state !== "verified") {
    const message = fixedText`update run ${literal(run.runId)} is ${literal(run.state)}; only a verified deploy can be accepted`;
    return { exitCode: UPDATE_EXIT.refused, runId: run.runId, state: run.state, message, report: reportOf(run) };
  }
  if (retirePending(run)) {
    const retired = await retireStep(ctx, run, true);
    if (!retired.ok) {
      const message = fixedText`update run ${literal(run.runId)} is not accepted: retiring its previous releases failed: ${retired.error}; their droplets can still be started by the platform; run update accept again once the target answers`;
      return { exitCode: UPDATE_EXIT.refused, runId: run.runId, state: run.state, message, report: reportOf(await readUpdateRun(ctx, run.runId)) };
    }
  }
  await ctx.journal.record("accept", "done", { phase: "accept", cutoverBackup: run.cutoverBackup });
  const accepted = await readUpdateRun(ctx, run.runId);
  const pinned = run.records.find((r) => r.step === "cutover-backup" && r.state === "done")?.data.pinned !== false;
  const message = fixedText`update run ${literal(run.runId)} accepted; the cutover backup ${literal(run.cutoverBackup ?? "(none)")} ${pinned ? literal("stays pinned until update cleanup") : literal("is kept by the retention")}, and a rollback from now on discards what was written since`;
  return { exitCode: UPDATE_EXIT.done, runId: run.runId, state: accepted.state, message, report: reportOf(accepted) };
}
