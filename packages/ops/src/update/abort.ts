import type { UpdateContext, UpdateOutcome, UpdateRun } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * `update abort`: ends an open run without finishing it. Before the promotion it starts the previous release again on
 * the unchanged replica and records `abort` with `promoted: false`; after the promotion it rolls back first
 * (`RollbackReason` `abort`), so the old droplet never starts on a converted generation.
 */
export async function abort(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  return notImplemented(`abort(${run.runId})`);
}
