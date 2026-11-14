import type { RollbackReason, RollbackResult, UpdateContext, UpdateOutcome, UpdateRun } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * Brings back the cutover state of deploy run `run`, in the order of `ROLLBACK_STEPS`, opened by a `rollback`
 * started record and closed by `rollback` done: stops the app if it runs and waits for the seal after STOPPED;
 * promotes the cutover backup's database again (before any old droplet can start); copies back originals whose
 * key holds other bytes; sets the delivery prefix to the backup's and lists it again until no key is newer than the
 * start of the replacement; checks the derived prefixes against the backup's ETag listing; restores the recorded
 * configuration verbatim, without a question; makes the previous droplet current (uploading its saved bits when it
 * was deleted); starts it and verifies it: readiness, and provenance through `applied.json` for a sealing runtime or
 * through the marker row in the first snapshot of an older one. Without a previous droplet or its bits the rollback
 * ends with the app stopped on the cutover state (`ended: "stopped"`).
 */
export async function rollback(ctx: UpdateContext, run: UpdateRun, reason: RollbackReason): Promise<RollbackResult> {
  return notImplemented(`rollback(${run.runId}, ${reason.kind})`);
}

/**
 * `update rollback`: rolls deploy run `run` back on request. Before `accept` it is lossless and asks nothing more; after
 * `accept` it shows the loss report and needs the environment's name as the answer to `rollback-accepted`. Exit 0 once
 * the previous release runs verified, 1 when the rollback could not finish.
 */
export async function rollbackCommand(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  return notImplemented(`rollbackCommand(${run.runId})`);
}
