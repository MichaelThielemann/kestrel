import { syncSchema, describeOp, type SyncDb } from './sync'
import { sqlite, type Dialect } from './dialect'
import type { SchemaSnapshot } from './model'

/**
 * The body of the dev-only schema auto-sync plugin, isolated so a failure can NEVER take down the whole
 * server. syncSchema throws by design on an infeasible migration (and on any transient DDL error); if
 * that escaped the Nitro plugin it would 500 every route — including the admin UI needed to diagnose it.
 * Here we log loudly and let the server keep running on the previous schema. The operator-triggered
 * db:migrate task is one-shot and keeps failing hard; only this always-on plugin must isolate.
 */
export function runDevSchemaSync(client: SyncDb, desired: SchemaSnapshot, dialect: Dialect = sqlite): void {
  try {
    const { applied, skipped } = syncSchema(client, desired, {}, dialect)
    if (applied.length) console.info(`[kestrel] dev schema auto-sync applied ${applied.length} statement(s)`)
    // Destructive changes are never auto-applied — name them so the data loss is visible before opting in.
    if (skipped.length) {
      console.warn(`[kestrel] ${skipped.length} destructive schema change(s) detected — not auto-applied:\n  - ${skipped.map(describeOp).join('\n  - ')}\n  apply with the db:migrate task ({ force: true }) — dev: GET /_nitro/tasks/db:migrate, prod: runTask('db:migrate', { payload: { force: true } })`)
    }
  } catch (err) {
    console.error('[kestrel] dev schema auto-sync FAILED — the server keeps running on the PREVIOUS schema; fix the collection or its data and restart:\n ', err instanceof Error ? err.message : err)
  }
}
