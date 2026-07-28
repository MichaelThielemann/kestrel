import collections from '#kestrel/collections'
import schemaTables from '#kestrel/schema-tables'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BuiltCollection } from '../../utils/collection-types'
import type { CollectionDef } from '../../utils/defineCollection'
import { resolveServerKestrel, serverRuntimeConfig } from '../../utils/server-config'
import { desiredFromCollections } from '../../schema/bootstrap'
import { planOps, syncSchema, isDestructive, describeOp, type SyncDb } from '../../schema/sync'
import { sqlite } from '../../schema/dialect'

// Explicit schema-migrate step for production (ADR-0002). Dev auto-syncs additively at boot
// (02.schema-sync); prod boot never auto-DDLs, so an operator runs this task. Triggering (Nuxt 4.4 /
// Nitro 2.13 — there is NO `nuxi task run`):
//   - dev:  GET http://localhost:3000/_nitro/tasks/db:migrate   (the dev-only task route)
//   - prod: call runTask('db:migrate', { payload }) from inside the process (an authenticated route or a
//           cron scheduledTask); the built node-server has no task CLI/endpoint.
// Payloads: {check:true}=dry-run (report pending DDL, change nothing); {force:true}=also apply REBUILDS
// (column drop/type change); {drop:["old_table"]}=drop a specific table (never bundled in force).
// Destructive ops are reported-but-withheld unless explicitly opted into; `force` never drops a table.
// The two run() branches return different result shapes (dry-run report vs applied/skipped); the explicit
// union is the task's result type so neither branch is forced to match the other.
type MigrateResult =
  | { check: boolean; pending: string[]; destructive: string[] }
  | { applied: string[]; skipped: string[] }

export default defineTask<MigrateResult>({
  meta: { name: 'db:migrate', description: 'Apply schema changes; {check:true}=dry-run, {force:true}=rebuilds, {drop:[names]}=drop tables' },
  run({ payload }) {
    const p = (payload ?? {}) as { check?: boolean; force?: boolean; drop?: string[] }
    const desired = desiredFromCollections(collections as (CollectionDef | BuiltCollection)[], {
      // Same toggle source as the registry plugin, so runtime surface and schema agree (see 02.schema-sync).
      toggles: (serverRuntimeConfig()?.kestrel?.collections ?? resolveServerKestrel().collections) as Record<string, boolean>,
      extraTables: schemaTables as AnySQLiteTable[],
    })
    const client = (useDb() as unknown as { $client: SyncDb }).$client
    // SQLite is the only backend today; this is the seam where a config-driven `resolveDialect()` would go.
    const dialect = sqlite

    if (p.check === true) {
      const ops = planOps(client, desired, dialect)
      const destructive = ops.filter(isDestructive).map(describeOp)
      console.info(`[kestrel] db:migrate dry-run: ${ops.length} pending op(s), ${destructive.length} destructive`)
      return { result: { check: true, pending: dialect.render(ops), destructive } }
    }

    const { applied, skipped } = syncSchema(client, desired, {
      allowDestructive: p.force === true,
      dropTables: Array.isArray(p.drop) ? p.drop : undefined,
    }, dialect)
    if (skipped.length) console.warn(`[kestrel] db:migrate withheld ${skipped.length} destructive change(s) — opt in with {"force":true} (rebuilds) / {"drop":[…]} (drops):\n  - ${skipped.map(describeOp).join('\n  - ')}`)
    console.info(`[kestrel] db:migrate applied ${applied.length} statement(s)`)
    return { result: { applied, skipped: skipped.map(describeOp) } }
  },
})
