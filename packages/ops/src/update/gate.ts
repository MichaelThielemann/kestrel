import { OpsError } from "../errors.ts";
import { parseJsonOrNull } from "../layout.ts";
import { stableList } from "../store.ts";
import { updateKeys } from "./layout.ts";
import { needsReceipt, planHash as hashOf, sameVersions } from "./plan.ts";
import type { TargetPreflight } from "./target.ts";
import { OPEN_STATES, type UpdateContext, type UpdatePlan, type UpdateReceipt, type UpdateRun } from "./types.ts";

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

function isReceipt(value: unknown): value is UpdateReceipt {
  if (typeof value !== "object" || value === null) return false;
  const versions: unknown = Reflect.get(value, "versions");
  return Reflect.get(value, "schema") === "kestrel-ops/update-receipt@1" && typeof Reflect.get(value, "env") === "string" && typeof Reflect.get(value, "runId") === "string" && typeof Reflect.get(value, "planHash") === "string" && typeof Reflect.get(value, "createdAt") === "number" && typeof versions === "object" && versions !== null && typeof Reflect.get(versions, "to") === "object";
}

/** The newest receipt of this environment for `planHash` whose `versions.to` equals `to`, or null. */
export async function findReceipt(ctx: UpdateContext, planHash: string, to: Readonly<Record<string, string>>): Promise<UpdateReceipt | null> {
  let newest: UpdateReceipt | null = null;
  for (const info of await stableList(ctx.backups, ctx.location + updateKeys.receipts(ctx.envName, planHash), ctx.poll)) {
    if (!info.key.endsWith(".json")) continue;
    const data = await ctx.backups.get(info.key);
    const value: unknown = data === null ? null : parseJsonOrNull(data);
    if (!isReceipt(value) || value.env !== ctx.envName || value.planHash !== planHash || !sameVersions(value.versions.to, to)) continue;
    if (newest === null || value.createdAt > newest.createdAt) newest = value;
  }
  return newest;
}

/**
 * Lets a deploy through or refuses it with exit 1 before anything changes: a version change or a pending storage
 * migration without a matching receipt, more than one instance (desired or running), an active deployment of the
 * platform, or an update run of this environment in an open state (`down`, `verifying`, `halted`, `rolling-back`).
 * A `verified` run before it is accepted implicitly; the gate names it in {@link GateResult.accepts}.
 */
export async function checkGate(ctx: UpdateContext, plan: UpdatePlan, previous: UpdateRun | null): Promise<GateResult> {
  const preflight = await ctx.target.preflight();
  if (preflight.instances > 1 || preflight.running > 1) throw new OpsError(`the app is scaled to ${Math.max(preflight.instances, preflight.running)} instances; an update needs exactly one`, 1, "gate");
  if (preflight.activeDeployment !== null) throw new OpsError(`a deployment of the platform is in progress (${preflight.activeDeployment}), such as a rolling push; wait until it ends`, 1, "gate");
  if (previous !== null && OPEN_STATES.has(previous.state)) throw new OpsError(`update run ${previous.runId} is ${previous.state}; finish it with update resume, update rollback or update abort --run ${previous.runId} first`, 1, "gate");
  const planHash = hashOf(plan);
  const ordinary = !needsReceipt(plan);
  const receipt = ordinary ? null : await findReceipt(ctx, planHash, plan.versions.to);
  if (!ordinary && receipt === null) {
    const why = plan.storage.length > 0 ? `${plan.storage.length} storage migration(s) pending` : "the versions change";
    throw new OpsError(`no receipt of update prepare matches this deploy (${why}, plan ${planHash.slice(0, 12)}); run update prepare --env ${ctx.envName} for this release and commit it`, 1, "gate");
  }
  return { receipt, ordinary, planHash, preflight, accepts: previous?.state === "verified" ? previous.runId : null };
}
