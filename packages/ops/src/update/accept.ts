import type { UpdateContext, UpdateOutcome, UpdateRun } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * Accepts a `verified` deploy run: records `accept`, after which a rollback discards what was written since and needs
 * the `rollback-accepted` answer. The cutover backup stays pinned until `update cleanup`. Refuses with exit 1 for a run
 * in any other state.
 */
export async function accept(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  return notImplemented(`accept(${run.runId})`);
}
