import type { UpdateContext, UpdateOutcome, UpdateRun } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * `update resume`: continues an interrupted run where its journal ended, after a `resume` record. A deploy continues
 * through `continueDeploy`; a rollback that did not finish runs again from its first step (every rollback step can be
 * repeated); a run whose verification failed is rolled back; a halted run is verified again. The ending is that of
 * the step it continued: exit 0 verified, 3 rolled back, 1 halted or refused.
 */
export async function resume(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  return notImplemented(`resume(${run.runId})`);
}
