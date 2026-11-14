import type { RetireResult, UpdateContext, UpdateRun } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * Retires the previous releases of deploy run `run` once its verification passed, and only then: saves the replaced
 * droplet's bits into the backup location when the target hands them out, then deletes every droplet but the current
 * one, so neither the platform's own rollback nor an old pipeline run can start an old release on the converted data.
 * Refuses unless the run's journal shows `verify` done with verdict `passed`.
 */
export async function retire(ctx: UpdateContext, run: UpdateRun): Promise<RetireResult> {
  return notImplemented(`retire(${run.runId})`);
}
