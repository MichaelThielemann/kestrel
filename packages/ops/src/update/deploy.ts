import type { UpdateContext, UpdateOutcome, UpdateRun } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * Deploys the release in the order of `DEPLOY_STEPS`. While the old release serves: `gate`, `stage` (a staging
 * failure ends the run with exit 1 and the app was never stopped), `configuration` (recorded once into the backup
 * location), `precopy`. Then `stop` (after the `update-stop` answer), `seal` (waits for the seal after STOPPED),
 * `cutover-backup` (verified, pinned for this run until `update cleanup`), `migrate` (on a copy of the cutover
 * database), and `promote`, `swap` and `start` as one step without a question between them. `verify` decides: passed
 * runs `retire` and ends with exit 0; failed runs the automatic rollback and ends with exit 3 once it verified the
 * cutover state; unverifiable halts with exit 1 and leaves the new release running.
 */
export async function deploy(ctx: UpdateContext): Promise<UpdateOutcome> {
  return notImplemented(`deploy(${ctx.envName})`);
}

/**
 * Continues deploy run `run` after its last done step (see `UpdateRun.lastDone`), checking that step's postcondition
 * first: a migration that did not finish starts again from the cutover backup's database; a promotion whose generation
 * is not the newest any more is refused; after `promote` it swaps and starts; after `start` it verifies.
 */
export async function continueDeploy(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  return notImplemented(`continueDeploy(${run.runId})`);
}
