import type { UpdateContext, UpdateOutcome, UpdateReceipt } from "./types.ts";
import { notImplemented } from "./pending.ts";

/** Options of {@link prepare}. */
export interface PrepareOptions {
  /** Download every original for the rehearsal instead of the ones the migrations touch and a sample. */
  fullMedia: boolean;
}

/** What {@link prepare} wrote. */
export interface PrepareResult {
  receipt: UpdateReceipt;
  outcome: UpdateOutcome;
}

/**
 * Prepares an update from this machine without changing production: preflight (read only: one instance, no active
 * deployment, replica live, backup location writable, clock skew), plan on a copy of the newest replica generation,
 * rehearsal of the migrations and a local start of the release on that copy, and the receipt with the version change
 * and the plan hash, written once into the backup location. Journal steps: `preflight`, `plan`, `rehearsal`,
 * `receipt`. A failed rehearsal check writes no receipt and ends with exit 1.
 */
export async function prepare(ctx: UpdateContext, options: PrepareOptions): Promise<PrepareResult> {
  return notImplemented(`prepare(${String(options.fullMedia)}, ${ctx.envName})`);
}
