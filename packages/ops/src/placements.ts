import type { OpsContext } from "./context.ts";
import { jsonBytes, keys } from "./layout.ts";
import { OpsError } from "./errors.ts";
import { markerKey, type Generation } from "./replica.ts";

/** Records in the backup location that this run places `generation`, before anything of it is written to the replica. */
export async function recordPlacement(ctx: OpsContext, generation: string): Promise<void> {
  await ctx.backups.put(ctx.location + keys.placement(ctx.envName, generation, ctx.runId), jsonBytes({ runId: ctx.runId, generation, at: ctx.clock() }), { contentType: "application/json" });
}

async function placedGenerations(ctx: OpsContext): Promise<Set<string>> {
  const base = `${ctx.location}placements/${ctx.envName}/`;
  const placed = new Set<string>();
  for (const info of await ctx.backups.list(base)) {
    const generation = info.key.slice(base.length).split("/")[0];
    if (generation !== undefined && generation !== "") placed.add(generation);
  }
  return placed;
}

/**
 * The newest generations of `gens` (oldest first) that a restore of this environment began to place and did not
 * finish: the tool recorded the placement, the generation holds no WAL segment, and neither the listing nor a read
 * shows its `origin.json`. Generations a runtime wrote, also ones that hold only a snapshot, never count.
 */
export async function unfinishedPlacements(ctx: OpsContext, gens: readonly Generation[]): Promise<string[]> {
  const placed = await placedGenerations(ctx);
  const unfinished: string[] = [];
  for (let i = gens.length - 1; i >= 0; i--) {
    const generation = gens[i];
    if (generation === undefined || !placed.has(generation.name) || generation.segments.length > 0 || generation.files["origin.json"] !== undefined) break;
    if ((await ctx.app.get(markerKey(ctx.env.app.replicaPrefix, generation.name, "origin"))) !== null) break;
    unfinished.unshift(generation.name);
  }
  return unfinished;
}

/** Refuses with a message naming the restore to run again when the newest generation is an unfinished placement. */
export async function refuseUnfinishedPlacement(ctx: OpsContext, gens: readonly Generation[]): Promise<void> {
  const unfinished = await unfinishedPlacements(ctx, gens);
  const newest = unfinished.at(-1);
  if (newest !== undefined) throw new OpsError(unfinishedMessage(newest), 1, `${ctx.env.app.replicaPrefix}gen/${newest}`);
}

/** The problem `status` and a refused backup name for an unfinished placement. */
export function unfinishedMessage(generation: string): string {
  return `generation ${generation} is an unfinished placement of a restore that failed; run that restore again`;
}
