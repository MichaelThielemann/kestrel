import type { TargetPreflight } from "./target.ts";
import type { UpdateContext, UpdatePlan, UpdateReceipt, UpdateRun } from "./types.ts";
import { notImplemented } from "./pending.ts";

/** What the gate let through. */
export interface GateResult {
  /** The matching receipt, or null for an ordinary deploy (no version change, no storage migration pending). */
  receipt: UpdateReceipt | null;
  ordinary: boolean;
  planHash: string;
  preflight: TargetPreflight;
  /** A verified deploy this one accepts implicitly, or null. */
  accepts: string | null;
}

/** The newest receipt of this environment for `planHash` whose `versions.to` equals `to`, or null. */
export async function findReceipt(ctx: UpdateContext, planHash: string, to: Readonly<Record<string, string>>): Promise<UpdateReceipt | null> {
  return notImplemented(`findReceipt(${planHash}, ${Object.keys(to).length})`);
}

/**
 * Lets a deploy through or refuses it with exit 1 before anything changes: a version change or a pending storage
 * migration without a matching receipt, more than one instance (desired or running), an active deployment of the
 * platform, or an update run of this environment in an open state (`down`, `verifying`, `halted`, `rolling-back`).
 * A `verified` run before it is accepted implicitly; the gate names it in {@link GateResult.accepts}.
 */
export async function checkGate(ctx: UpdateContext, plan: UpdatePlan, previous: UpdateRun | null): Promise<GateResult> {
  return notImplemented(`checkGate(${plan.content.length}, ${previous?.runId ?? "none"})`);
}
