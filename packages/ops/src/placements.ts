import type { OpsContext } from "./context.ts";
import { jsonBytes, keys } from "./layout.ts";
import { OpsError } from "./errors.ts";
import { markerKey, type Generation } from "./replica.ts";
import { stableList } from "./store.ts";

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

const JOURNAL_KEY = /(\d{6})-(.+)-(?:started|done|failed|skipped)\.json$/;

async function startedAfterPromote(ctx: OpsContext, runId: string): Promise<boolean> {
  const steps = (await stableList(ctx.backups, `${ctx.location}runs/${runId}/`, ctx.poll)).flatMap((info) => {
    const m = JOURNAL_KEY.exec(info.key);
    return m ? [{ seq: Number(m[1]), step: m[2] ?? "" }] : [];
  });
  const promoted = Math.min(...steps.filter((entry) => entry.step === "promote").map((entry) => entry.seq));
  return steps.some((entry) => entry.step === "start" && (!Number.isFinite(promoted) || entry.seq > promoted));
}

/**
 * Whether a restore of this environment recorded the placement of `generation` and none of the runs that placed it
 * started the app afterwards, as their journals show. Only then is a generation without segments the whole database.
 */
export async function placedUnstarted(ctx: OpsContext, generation: string): Promise<boolean> {
  const base = `${ctx.location}placements/${ctx.envName}/${generation}/`;
  const runs = (await stableList(ctx.backups, base, ctx.poll)).map((info) => info.key.slice(base.length)).filter((rest) => rest.endsWith(".json") && !rest.includes("/")).map((rest) => rest.slice(0, -".json".length));
  if (runs.length === 0) return false;
  for (const runId of runs) if (await startedAfterPromote(ctx, runId)) return false;
  return true;
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
