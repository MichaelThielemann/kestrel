import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'

/** Retention cap for `publish_runs`: `startPublishRun` prunes non-`running` rows beyond the newest N after
 *  every insert, so an unattended server never grows this table without bound. `running` rows are never
 *  pruned regardless of age — a crashed run must stay visible to `resumePublishRuns` until it is resolved.
 *  Also the read pipeline's page size (`layers/public/server/pipelines/publish-runs.ts`), so a caller never
 *  reads more history than what pruning actually keeps.
 *
 *  Accepted gap: a permanently failing publish (e.g. a misconfigured output target) churns through up to
 *  N rows of the SAME failure before the oldest copies age out — pruning keeps the table bounded, but does
 *  nothing to collapse repeats. Collapsing identical consecutive failures into one row (bumping a count
 *  instead of inserting) is a reasonable future refinement, not implemented here.
 * @public
 */
export const PUBLISH_RUNS_RETENTION = 100

// The orchestrator's own state table: one row per publish run, updated in place across its
// command -> snapshot -> delivery -> done sequence (never appended-to), so a crash mid-run leaves exactly
// one row behind for `resumePublishRuns` to find and resolve. `error` is null except on a `failed` row.
// Hand-authored system table (not a collection) — registered in the desired schema via bootstrap.ts +
// re-exported from collections/schema.ts, mirroring `publish_deps` / `publish_status`.
/** The `publish_runs` Drizzle table.
 * @public
 */
export const publishRuns = sqliteTable('publish_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  step: text('step').notNull(), // 'command' | 'snapshot' | 'delivery' | 'done'
  status: text('status').notNull(), // 'running' | 'done' | 'failed'
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  // `resumePublishRuns`'s own query: `WHERE status = 'running'` — an index scan, not a full table scan,
  // as the run history grows. Trailing `id` lets it read the oldest crashed run first.
  index('publish_runs_status').on(t.status, t.id),
])
