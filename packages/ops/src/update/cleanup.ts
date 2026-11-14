import type { UpdateContext, UpdateOutcome, UpdateRun } from "./types.ts";
import { notImplemented } from "./pending.ts";

/** Options of {@link cleanup}. */
export interface CleanupOptions {
  /** List what cleanup would remove without removing it. */
  dryRun: boolean;
}

/**
 * `update cleanup`: ends an accepted deploy run at least `update.cleanupAfterDays` after its `accept`. Steps
 * `cleanup-check` (refuses before that, or for a run that is not accepted), `cleanup-delete` (originals under the media
 * prefix that no row of the current replica references and that the cutover backup holds, after the `cleanup-delete`
 * answer) and `unpin` (releases the update pin of the cutover backup, so prune treats it like any other).
 */
export async function cleanup(ctx: UpdateContext, run: UpdateRun, options: CleanupOptions): Promise<UpdateOutcome> {
  return notImplemented(`cleanup(${run.runId}, ${String(options.dryRun)})`);
}
