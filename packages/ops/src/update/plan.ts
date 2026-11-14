import type { UpdateContext, UpdatePlan, VersionSet } from "./types.ts";
import { notImplemented } from "./pending.ts";

/** The packages a version change is decided on: every installed package whose name starts with this. */
export const VERSIONED_PACKAGES = "@michaelthielemann/kestrel";

/** The versions of `packages` whose name starts with {@link VERSIONED_PACKAGES}, sorted by name. */
export function versionSet(packages: Readonly<Record<string, string>>): VersionSet {
  return notImplemented(`versionSet(${Object.keys(packages).length})`);
}

/**
 * The versions the app runs: those the target reports when it reports any of {@link VERSIONED_PACKAGES}, otherwise
 * the `versions.to` of the newest verified deploy of this environment, or null when neither exists, which counts as a
 * version change.
 */
export async function runningVersions(ctx: UpdateContext): Promise<VersionSet | null> {
  return notImplemented(`runningVersions(${ctx.envName})`);
}

/**
 * Plans the update on `database`, a copy of the newest replica generation: the storage-shape migrations of the
 * release's modules that detect their old form (detect and plan only, no row or blob is written), and the content
 * migrations of the release that the copy's ledger does not hold. `versions` is the change from
 * {@link runningVersions} to the release's {@link versionSet}.
 */
export async function computePlan(ctx: UpdateContext, database: string): Promise<UpdatePlan> {
  return notImplemented(`computePlan(${database})`);
}

/**
 * The sha256 (hex) of the canonical JSON of the plan's `versions.to`, the sorted ids of its storage migrations with
 * their `kind` and `blobWrites`, and the sorted ids of its content migrations; counts and questions are left out.
 */
export function planHash(plan: UpdatePlan): string {
  return notImplemented(`planHash(${plan.storage.length})`);
}
