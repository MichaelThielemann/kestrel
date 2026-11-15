import { OpsError } from "../errors.ts";
import { parseJsonOrNull } from "../layout.ts";
import { stableList } from "../store.ts";
import { updateKeys } from "./layout.ts";
import { retirePending } from "./journal.ts";
import { needsReceipt, planHash as hashOf, sameVersions } from "./plan.ts";
import { nextCommand } from "./status.ts";
import type { TargetPreflight } from "./target.ts";
import { OPEN_STATES, type UpdateContext, type UpdatePlan, type UpdateReceipt, type UpdateRun } from "./types.ts";
import { fixedText, literal } from "../redact.ts";

/** What the gate let through. */
export interface GateResult {
  /** The matching receipt, or null for an ordinary deploy (no version change, no storage migration pending). */
  receipt: UpdateReceipt | null;
  ordinary: boolean;
  planHash: string;
  preflight: TargetPreflight;
  /** A verified deploy this one accepts implicitly, or null. */
  accepts: string | null;
  /** The fingerprint of the configuration the release brings, from `UpdateTarget.checkReleaseConfiguration`, or null. */
  configuration: string | null;
}

/** Why prepare and the gate refuse a target whose readiness probe cannot tell a ready release from a broken one. */
export const UNCHECKED_READINESS = "the target cannot check the readiness of the release and would count any running instance as ready; configure its readiness URL (readyUrl of the target) so verification can tell 200 from 503 and 403";

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
 * Lets a deploy through or refuses it before anything changes, with exit 2 for a target that cannot check readiness
 * ({@link TargetPreflight.readinessChecked} false), for pending content migrations without `update.localBoot` and for
 * a release configuration the target refuses (`UpdateTarget.checkReleaseConfiguration`, its sources resolved), and
 * otherwise with exit 1: a version change or a pending storage
 * migration without a matching receipt, more than one instance (desired or running), an active deployment of the
 * platform, or any of the `earlier` deploy runs of this environment (oldest first) in an open state (`deploying`,
 * `down`, `verifying`, `halted`, `rolling-back`) or verified or accepted with its retire of the previous releases not
 * ended ({@link retirePending}). The newest earlier run that got past its gate, when it is `verified`,
 * is accepted implicitly; the gate names it in {@link GateResult.accepts}.
 */
export async function checkGate(ctx: UpdateContext, plan: UpdatePlan, earlier: readonly UpdateRun[]): Promise<GateResult> {
  const preflight = await ctx.target.preflight();
  if (preflight.instances > 1 || preflight.running > 1) throw new OpsError(`the app is scaled to ${Math.max(preflight.instances, preflight.running)} instances; an update needs exactly one`, 1, "gate");
  if (preflight.activeDeployment !== null) throw new OpsError(`a deployment of the platform is in progress (${preflight.activeDeployment}), such as a rolling push; wait until it ends`, 1, "gate");
  if (preflight.readinessChecked === false) throw new OpsError(UNCHECKED_READINESS, 2, "gate");
  if (plan.content.length > 0 && ctx.update.localBoot === undefined) throw new OpsError(`${plan.content.length} content migration(s) are pending (${plan.content.join(", ")}), but update.localBoot is not set, so the deploy could not apply them after the stop`, 2, "gate");
  const configuration = (await ctx.target.checkReleaseConfiguration?.({ dir: ctx.release.dir }, { resolveSources: true }))?.fingerprint ?? null;
  const open = earlier.find((run) => OPEN_STATES.has(run.state));
  if (open !== undefined) throw new OpsError(fixedText`update run ${literal(open.runId)} is ${literal(open.state)}; finish it first with ${nextCommand(open, "update deploy") ?? fixedText`kestrel update abort --env ${literal(ctx.envName)} --run ${literal(open.runId)}`}`, 1, "gate");
  const retiring = earlier.find(retirePending);
  if (retiring !== undefined) throw new OpsError(fixedText`update run ${literal(retiring.runId)} is ${literal(retiring.state)}, but its previous releases are not retired, so they can still start on its data; retire them first with kestrel update resume --env ${literal(ctx.envName)} --run ${literal(retiring.runId)}`, 1, "gate");
  const previous = earlier.filter((run) => run.state !== "untouched").at(-1) ?? null;
  const planHash = hashOf(plan);
  const ordinary = !needsReceipt(plan);
  const receipt = ordinary ? null : await findReceipt(ctx, planHash, plan.versions.to);
  if (!ordinary && receipt === null) {
    const why = plan.storage.length > 0 ? `${plan.storage.length} storage migration(s) pending` : "the versions change";
    throw new OpsError(fixedText`no receipt of update prepare matches this deploy (${why}, plan ${planHash.slice(0, 12)}); run update prepare --env ${literal(ctx.envName)} for this release and commit it`, 1, "gate");
  }
  return { receipt, ordinary, planHash, preflight, accepts: previous?.state === "verified" ? previous.runId : null, configuration };
}
