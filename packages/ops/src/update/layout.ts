import { keys as backupKeys } from "../layout.ts";

/**
 * The prefix of a pin an update run holds on its cutover backup. A pin whose run id starts with it keeps the backup
 * from prune until `update cleanup` releases it, whether or not the run is still open.
 */
export const UPDATE_PIN_PREFIX = "update-";

/**
 * Keys an update writes in the backup location, besides the journal (`runs/<run>/…`), the lock trace and the cutover
 * backup itself. Every key is written once and never overwritten; only saved droplet bits are deleted again.
 */
export const updateKeys = {
  /** The receipt of a prepare run, found by the plan hash it rehearsed. */
  receipt: (env: string, planHash: string, runId: string) => `updates/${env}/receipts/${planHash}/${runId}.json`,
  receipts: (env: string, planHash: string) => `updates/${env}/receipts/${planHash}/`,
  /** The configuration a deploy recorded before it changed the app. */
  configuration: (env: string, runId: string) => `updates/${env}/runs/${runId}/configuration.json`,
  /** The bits of the droplet a deploy replaced, saved before the droplet was deleted. */
  droplet: (env: string, runId: string, guid: string) => `updates/${env}/runs/${runId}/droplet-${guid}.tgz`,
  /** The prefix of the keys every deploy run of `env` writes besides its journal: its configuration and the droplet bits it saved. */
  runs: (env: string) => `updates/${env}/runs/`,
  /** The prefix of every droplet's bits a deploy saved; `update cleanup` of the run, or `retire` of a later verified deploy once the run is closed and holds no update pin, removes them. */
  droplets: (env: string, runId: string) => `updates/${env}/runs/${runId}/droplet-`,
  /** The update pin on a backup: a `pins/` key of the backup with the run id behind {@link UPDATE_PIN_PREFIX}. */
  pin: (backupId: string, runId: string) => backupKeys.pin(backupId, UPDATE_PIN_PREFIX + runId),
  unpin: (backupId: string, runId: string) => backupKeys.unpin(backupId, UPDATE_PIN_PREFIX + runId),
};
