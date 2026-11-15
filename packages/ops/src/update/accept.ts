import { readUpdateRun, reportOf } from "./journal.ts";
import { UPDATE_EXIT, type UpdateContext, type UpdateOutcome, type UpdateRun } from "./types.ts";

/**
 * Accepts a `verified` deploy run: records `accept`, after which a rollback discards what was written since and needs
 * the `rollback-accepted` answer. A pinned cutover backup stays pinned until `update cleanup`. Refuses with exit 1
 * for a run in any other state.
 */
export async function accept(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  if (run.state !== "verified") {
    const message = `update run ${run.runId} is ${run.state}; only a verified deploy can be accepted`;
    return { exitCode: UPDATE_EXIT.refused, runId: run.runId, state: run.state, message, report: reportOf(run) };
  }
  await ctx.journal.record("accept", "done", { phase: "accept", cutoverBackup: run.cutoverBackup });
  const accepted = await readUpdateRun(ctx, run.runId);
  const pinned = run.records.find((r) => r.step === "cutover-backup" && r.state === "done")?.data.pinned !== false;
  const message = `update run ${run.runId} accepted; the cutover backup ${run.cutoverBackup ?? "(none)"} ${pinned ? "stays pinned until update cleanup" : "is kept by the retention"}, and a rollback from now on discards what was written since`;
  return { exitCode: UPDATE_EXIT.done, runId: run.runId, state: accepted.state, message, report: reportOf(accepted) };
}
