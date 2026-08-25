import { desc } from 'drizzle-orm'
import { Effect } from 'effect'
import { definePipeline, syncStep } from '@kestrel/core'
import type { PipelineDef, StepDef } from '@kestrel/core'
import { publishRuns, PUBLISH_RUNS_RETENTION } from '../database/publish-runs.js'
import { usePublishingDb } from '../db/publishing-db.js'

// Newest-first, capped at the same N the orchestrator prunes down to (`PUBLISH_RUNS_RETENTION`) — this
// read can never see more history than what pruning actually keeps around.
const listPublishRuns: StepDef = syncStep('listPublishRuns', (ctx) => Effect.sync(() => {
  ctx.output = { data: usePublishingDb().db.select().from(publishRuns).orderBy(desc(publishRuns.id)).limit(PUBLISH_RUNS_RETENTION).all() }
}))

/** Collection-less read of the publish orchestrator's persisted state — `resource: '_publish/runs'`
 *  follows the same `<namespace>/<tool>` shape as `_outbox/dead`. This IS the badge's data source: it
 *  reports `publish_runs` as-persisted, so a completed or failed run never reads back as `running` (see
 *  `orchestrator.ts` — every step transition is written before the next one starts).
 *
 *  `access.role` here is documentation, not enforcement, exactly as on `outboxDead` — the production gate
 *  evaluator authorizes purely by resource against the hardcoded `POLICY` grant table; what actually keeps
 *  this admin-reachable is `admin`'s wildcard `{ action: 'read', resource: '*' }` grant matching
 *  `_publish/runs` (anonymous has no grants at all, so it's refused). See `outbox.ts`'s own TSDoc for the
 *  full account, including the `renderer` wildcard-grant caveat, which applies identically here.
 * @public
 */
export function buildPublishRunsPipelines(): PipelineDef[] {
  return [
    definePipeline({
      name: 'publishRuns',
      read: true,
      access: { role: 'admin', resource: '_publish/runs' },
      steps: [listPublishRuns],
    }),
  ]
}
