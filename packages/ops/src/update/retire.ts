import { readFileSync } from "node:fs";
import { OpsError } from "../errors.ts";
import { listUpdateRuns, readUpdateRun } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { OPEN_STATES, type RetireResult, type UpdateContext, type UpdateRun } from "./types.ts";

const verifiedPassed = (run: UpdateRun): boolean => (run.state === "verified" || run.state === "accepted") && run.records.some((r) => r.step === "verify" && r.state === "done" && (r.phase === "deploy" || r.phase === "verify") && r.data.verdict === "passed");

async function saveBits(ctx: UpdateContext, run: UpdateRun, guid: string): Promise<string | null> {
  const key = updateKeys.droplet(ctx.envName, run.runId, guid);
  if ((await ctx.backups.head(ctx.location + key)) !== null) return key;
  if (ctx.target.saveDroplet === undefined) return null;
  const file = ctx.workspace.path(`droplet-${guid}`);
  if (!(await ctx.target.saveDroplet(guid, file))) return null;
  await ctx.backups.put(ctx.location + key, new Uint8Array(readFileSync(file)), { contentType: "application/octet-stream" });
  if ((await ctx.backups.head(ctx.location + key)) === null) throw new OpsError(`the bits of droplet ${guid} do not read back from ${key}`, 1, key);
  return key;
}

async function neededByOpenRuns(ctx: UpdateContext, run: UpdateRun): Promise<Map<string, UpdateRun>> {
  const needed = new Map<string, UpdateRun>();
  for (const entry of await listUpdateRuns(ctx, ctx.envName)) {
    if (entry.command !== "update deploy" || entry.runId === run.runId) continue;
    const other = await readUpdateRun(ctx, entry.runId);
    if (!OPEN_STATES.has(other.state)) continue;
    for (const droplet of [other.previousDroplet, other.stagedDroplet]) if (droplet !== null) needed.set(droplet, other);
  }
  return needed;
}

/**
 * Retires the previous releases of deploy run `run` once its verification passed, and only then: saves the replaced
 * droplet's bits into the backup location when the target hands them out, then deletes every droplet but the current
 * one, so neither the platform's own rollback nor an old pipeline run can start an old release on the converted data.
 * Refuses unless the run's journal shows `verify` done with verdict `passed`, and while the app runs another droplet
 * than the one the run deployed. A droplet that another open deploy run of the environment recorded as its previous or
 * staged droplet stays.
 */
export async function retire(ctx: UpdateContext, run: UpdateRun): Promise<RetireResult> {
  if (!verifiedPassed(run)) throw new OpsError(`refusing to retire the previous releases of run ${run.runId}: its verification has not passed (the run is ${run.state}); a rollback still needs them`, 1, "retire");
  const droplets = await ctx.target.listDroplets();
  const current = droplets.find((d) => d.current)?.guid ?? (await ctx.target.currentDroplet());
  if (current === null || (run.stagedDroplet !== null && current !== run.stagedDroplet)) throw new OpsError(`refusing to retire the previous releases: the app runs droplet ${current ?? "(none)"}, not the droplet run ${run.runId} deployed (${run.stagedDroplet ?? "unknown"})`, 1, "retire");
  const previous = run.previousDroplet;
  let savedDroplet: string | null = null;
  if (previous !== null && previous !== current && droplets.some((d) => d.guid === previous)) {
    savedDroplet = await saveBits(ctx, run, previous);
    if (savedDroplet === null) ctx.out.warn(`the target hands out no bits of droplet ${previous}; once it is deleted, a rollback of run ${run.runId} brings back the cutover state but leaves the app stopped`);
  }
  const revisions = await ctx.target.listRevisions();
  const needed = await neededByOpenRuns(ctx, run);
  const deleted: string[] = [];
  for (const droplet of droplets) {
    if (droplet.guid === current) continue;
    const other = needed.get(droplet.guid);
    if (other !== undefined) {
      ctx.out.warn(`droplet ${droplet.guid} stays: update run ${other.runId} is ${other.state} and needs it to roll back`);
      continue;
    }
    await ctx.target.deleteDroplet(droplet.guid);
    deleted.push(droplet.guid);
  }
  const lost = revisions.filter((r) => r.droplet !== null && deleted.includes(r.droplet)).map((r) => r.guid);
  if (deleted.length > 0) ctx.out.info(`deleted ${deleted.length} droplet(s) of earlier releases; ${lost.length} revision(s) can no longer be rolled back to by the platform`);
  return { droplets: deleted, revisions: lost, savedDroplet };
}
