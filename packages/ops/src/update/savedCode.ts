import type { OpsContext } from "../context.ts";
import { stableList, type ObjectInfo } from "../store.ts";
import { listUpdateRuns, readUpdateRun } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { OPEN_STATES, type UpdateRun, type UpdateRunState } from "./types.ts";

type SavedCodeContext = Pick<OpsContext, "backups" | "location" | "poll" | "envName">;

const SUPERSEDING: ReadonlySet<UpdateRunState> = new Set(["verified", "accepted", "cleaned"]);

/** True while run `run` holds an update pin on its cutover backup that no release record cancels. */
export async function holdsUpdatePin(ctx: Pick<OpsContext, "backups" | "location">, run: Pick<UpdateRun, "runId" | "cutoverBackup">): Promise<boolean> {
  if (run.cutoverBackup === null) return false;
  if ((await ctx.backups.head(ctx.location + updateKeys.pin(run.cutoverBackup, run.runId))) === null) return false;
  return (await ctx.backups.head(ctx.location + updateKeys.unpin(run.cutoverBackup, run.runId))) === null;
}

/** Deletes the droplet bits run `runId` saved into the backup location and resolves to their keys. */
export async function removeSavedDroplets(ctx: SavedCodeContext, runId: string): Promise<string[]> {
  const saved = (await stableList(ctx.backups, ctx.location + updateKeys.droplets(ctx.envName, runId), ctx.poll)).map((info) => info.key);
  for (const key of saved) await ctx.backups.delete(key);
  return saved;
}

/**
 * The droplet bits deploy runs of `ctx.envName` saved into the backup location that no rollback can use any more:
 * those of a run that is not open, holds no update pin on its cutover backup, and that a later deploy run superseded
 * by retiring the previous releases (its retire is done and it is verified, accepted or cleaned). The `retire` step of
 * that later run deletes them; they are still there when its credentials may not delete in the backup location.
 */
export async function obsoleteSavedCode(ctx: SavedCodeContext): Promise<ObjectInfo[]> {
  const deploys: UpdateRun[] = [];
  for (const entry of await listUpdateRuns(ctx, ctx.envName)) if (entry.command === "update deploy") deploys.push(await readUpdateRun(ctx, entry.runId));
  const obsolete = new Set<string>();
  for (const [at, run] of deploys.entries()) {
    const superseded = deploys.slice(at + 1).some((later) => SUPERSEDING.has(later.state) && later.records.some((r) => r.step === "retire" && r.state === "done"));
    if (superseded && !OPEN_STATES.has(run.state) && !(await holdsUpdatePin(ctx, run))) obsolete.add(run.runId);
  }
  if (obsolete.size === 0) return [];
  const runs = ctx.location + updateKeys.runs(ctx.envName);
  return (await stableList(ctx.backups, runs, ctx.poll)).filter((info) => {
    const runId = /^([^/]+)\/droplet-[^/]+$/.exec(info.key.slice(runs.length))?.[1];
    return runId !== undefined && obsolete.has(runId);
  });
}
