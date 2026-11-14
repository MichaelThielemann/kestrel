import type { MigrateInput, MigrateResult, UpdateContext } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * Migrates a copy of the cutover backup's database (phase `contentMigrations`, steps `copy`, `storage-migrations`,
 * `content-migrations`, `migrate-check`): always starts from a fresh download of the cutover `db.sqlite`, so a run
 * killed in the middle of a migration that is not idempotent starts again from the same state; applies the planned
 * storage-shape migrations with blob writes going expand-only into the app's store through server-side copies while
 * the app is stopped; applies the content migrations through `runContentMigrations`; then checks that no storage
 * migration is pending and that only the content-migration ledger and migrated collections changed. Refuses a
 * migration the plan does not name.
 */
export async function migrateCopy(ctx: UpdateContext, input: MigrateInput): Promise<MigrateResult> {
  return notImplemented(`migrateCopy(${input.cutoverBackup})`);
}
