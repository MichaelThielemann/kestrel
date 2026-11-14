import type { UpdateContext, UpdateOutcome, UpdateRun, VerifyInput, VerifyResult } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * Verifies a started release. Hard checks: an instance runs and the platform recorded no crash since the start;
 * readiness in three outcomes (ready; not-ready fails; unverifiable halts); `applied.json` of the promoted generation
 * names it and the nonce of its `origin.json`; the release's own generation, sorting after the promoted one, shows its
 * first snapshot; the newest object of that generation advances within `update.syncWindowSeconds`; a key under the
 * delivery prefix newer than the start shows that a render began within `update.renderTimeoutSeconds`. Soft checks
 * (pages and media of the delivery prefix answering) only warn.
 */
export async function verifyRelease(ctx: UpdateContext, input: VerifyInput): Promise<VerifyResult> {
  return notImplemented(`verifyRelease(${input.promoted.generation})`);
}

/** `update verify`: verifies the running release of deploy run `run` again, for a halted run once readiness can be checked. */
export async function verifyCommand(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  return notImplemented(`verifyCommand(${run.runId})`);
}
