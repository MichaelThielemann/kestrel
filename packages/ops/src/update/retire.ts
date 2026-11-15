import { readFileSync } from "node:fs";
import { messageOf } from "../context.ts";
import { OpsError } from "../errors.ts";
import { Interrupted } from "../interrupt.ts";
import { fixedText, literal } from "../redact.ts";
import { stableList } from "../store.ts";
import { listUpdateRuns, readUpdateRun } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { holdsUpdatePin } from "./savedCode.ts";
import { OPEN_STATES, type RetireResult, type UpdateContext, type UpdateRun } from "./types.ts";

const verifiedPassed = (run: UpdateRun): boolean => (run.state === "verified" || run.state === "accepted") && run.records.some((r) => r.step === "verify" && r.state === "done" && (r.phase === "deploy" || r.phase === "verify") && r.data.verdict === "passed");

async function saveBits(ctx: UpdateContext, run: UpdateRun, guid: string): Promise<string | null> {
  const key = updateKeys.droplet(ctx.envName, run.runId, guid);
  if ((await ctx.backups.head(ctx.location + key)) !== null) return key;
  if (ctx.target.saveDroplet === undefined) return null;
  const file = ctx.workspace.path(`droplet-${guid}`);
  if (!(await ctx.target.saveDroplet(guid, file))) return null;
  await ctx.backups.put(ctx.location + key, new Uint8Array(readFileSync(file)), { contentType: "application/octet-stream" });
  if ((await ctx.backups.head(ctx.location + key)) === null) throw new OpsError(fixedText`the bits of droplet ${literal(guid)} do not read back from ${key}`, 1, key);
  return key;
}

async function otherDeploys(ctx: UpdateContext, run: UpdateRun): Promise<{ needed: Map<string, UpdateRun>; closed: string[] }> {
  const needed = new Map<string, UpdateRun>();
  const closed: string[] = [];
  for (const entry of await listUpdateRuns(ctx, ctx.envName)) {
    if (entry.command !== "update deploy" || entry.runId === run.runId) continue;
    const other = await readUpdateRun(ctx, entry.runId);
    if (!OPEN_STATES.has(other.state)) {
      if (!(await holdsUpdatePin(ctx, other))) closed.push(other.runId);
      continue;
    }
    for (const droplet of [other.previousDroplet, other.stagedDroplet]) if (droplet !== null) needed.set(droplet, other);
  }
  return { needed, closed };
}

async function removeObsoleteCode(ctx: UpdateContext, runIds: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  let refusal: string | null = null;
  const leave = (key: string, error: unknown): void => {
    if (error instanceof Interrupted) throw error;
    left.push(key);
    refusal ??= messageOf(error);
  };
  for (const runId of runIds) {
    const prefix = ctx.location + updateKeys.droplets(ctx.envName, runId);
    let saved: string[];
    try {
      saved = (await stableList(ctx.backups, prefix, ctx.poll)).map((info) => info.key);
    } catch (error) {
      leave(`${prefix}*`, error);
      continue;
    }
    for (const key of saved) await ctx.backups.delete(key).catch((error: unknown) => leave(key, error));
  }
  if (refusal !== null) ctx.out.warn(fixedText`the saved code of earlier releases, which no rollback needs any more, stays: deleting it failed (${refusal}); kestrel backup prune --env ${literal(ctx.envName)} removes it with credentials that may delete under ${ctx.location}${literal("updates/")} once it is a day old: ${left.join(", ")}`);
  return left;
}

/**
 * Retires the previous releases of deploy run `run` once its verification passed, and only then: saves the replaced
 * droplet's bits into the backup location when the target hands them out, then deletes every droplet but the current
 * one, also when saving the bits failed, so neither the platform's own rollback nor an old pipeline run can start an
 * old release on the converted data.
 * Refuses unless the run's journal shows `verify` done with verdict `passed`, and while the app runs another droplet
 * than the one the run deployed. A droplet that another open deploy run of the environment recorded as its previous or
 * staged droplet stays. The droplet bits that earlier deploy runs of the environment saved are deleted once those runs
 * are no longer open and hold no update pin on their cutover backup; a pinned run keeps them until `update cleanup`,
 * so its rollback can start the release before it. A failure to delete those bits, such as credentials without delete
 * rights in the backup location, does not fail the step: it warns once, naming the keys left behind and `backup prune`,
 * which removes them, and returns them as `leftovers`.
 */
export async function retire(ctx: UpdateContext, run: UpdateRun): Promise<RetireResult> {
  if (!verifiedPassed(run)) throw new OpsError(fixedText`refusing to retire the previous releases of run ${literal(run.runId)}: its verification has not passed (the run is ${literal(run.state)}); a rollback still needs them`, 1, "retire");
  const droplets = await ctx.target.listDroplets();
  const current = droplets.find((d) => d.current)?.guid ?? (await ctx.target.currentDroplet());
  if (current === null || (run.stagedDroplet !== null && current !== run.stagedDroplet)) throw new OpsError(fixedText`refusing to retire the previous releases: the app runs droplet ${literal(current ?? "(none)")}, not the droplet run ${literal(run.runId)} deployed (${literal(run.stagedDroplet ?? "unknown")})`, 1, "retire");
  const previous = run.previousDroplet;
  let savedDroplet: string | null = null;
  const kept: string[] = [];
  if (previous !== null && previous !== current && droplets.some((d) => d.guid === previous)) {
    try {
      savedDroplet = await saveBits(ctx, run, previous);
      if (savedDroplet === null) ctx.out.warn(fixedText`the target hands out no bits of droplet ${literal(previous)}; once it is deleted, a rollback of run ${literal(run.runId)} brings back the cutover state but leaves the app stopped`);
    } catch (error) {
      ctx.out.warn(fixedText`saving the bits of droplet ${literal(previous)} failed (${messageOf(error)}); it is deleted all the same, so no old release starts on the converted data, and a rollback of run ${literal(run.runId)} brings back the cutover state but leaves the app stopped`);
    }
  }
  const revisions = await ctx.target.listRevisions();
  const { needed, closed } = await otherDeploys(ctx, run);
  const deleted: string[] = [];
  for (const droplet of droplets) {
    if (droplet.guid === current || kept.includes(droplet.guid)) continue;
    const other = needed.get(droplet.guid);
    if (other !== undefined) {
      kept.push(droplet.guid);
      ctx.out.warn(fixedText`droplet ${literal(droplet.guid)} stays: update run ${literal(other.runId)} is ${literal(other.state)} and needs it to roll back`);
      continue;
    }
    await ctx.target.deleteDroplet(droplet.guid);
    deleted.push(droplet.guid);
  }
  const lost = revisions.filter((r) => r.droplet !== null && deleted.includes(r.droplet)).map((r) => r.guid);
  if (deleted.length > 0) ctx.out.info(`deleted ${deleted.length} droplet(s) of earlier releases; ${lost.length} revision(s) can no longer be rolled back to by the platform`);
  const leftovers = await removeObsoleteCode(ctx, closed);
  return { droplets: deleted, revisions: lost, savedDroplet, kept, leftovers };
}
