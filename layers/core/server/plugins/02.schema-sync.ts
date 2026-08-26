import collections from '#kestrel/collections'
import schemaTables from '#kestrel/schema-tables'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { describeOp, desiredFromCollections, isDestructive, planOps, runDevSchemaSync, sqlite, useDb } from '@michaelthielemann/kestrel-core'
import type { BuiltCollection, CollectionDef, SyncDb } from '@michaelthielemann/kestrel-core'
import { resolveServerKestrel, serverRuntimeConfig } from '../utils/server-config'
// Dev-only schema auto-sync (ADR-0002). Runs after 00.migrate, so built-in collections are already
// migrated and this is a no-op on them; it additively reconciles the live DB to whatever the registered
// collections (+ the discovered standalone tables) now compile to — so adding a collection or a field
// shows up without a hand-written migration. NEVER auto-DDLs in production or during prerender (`nuxt
// generate`), where schema changes go through committed migrations / an explicit migrate step instead —
// but production DOES a read-only DRIFT CHECK and warns loudly, so an upgraded consumer that forgot to
// run `db:migrate` sees a clear boot warning instead of scattered runtime errors.
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return

  const desired = desiredFromCollections(collections as (CollectionDef | BuiltCollection)[], {
    // Same toggle source as the registry plugin (01.register), so a disabled built-in is dropped from
    // the desired schema exactly as it is dropped from the runtime surface.
    toggles: (serverRuntimeConfig()?.kestrel?.collections ?? resolveServerKestrel().collections) as Record<string, boolean>,
    extraTables: schemaTables as AnySQLiteTable[],
  })
  const client = (useDb() as unknown as { $client: SyncDb }).$client

  if (process.env.NODE_ENV === 'production') {
    // Read-only: never DDL in prod. Detect + surface drift so the operator runs db:migrate. Split by kind:
    // ADDITIVE gaps (missing table/column/index) can make the app error → a real "run db:migrate" warning.
    // DESTRUCTIVE ops (a drop for a disabled built-in, or an unmanaged extra table) are NOT app-breaking and
    // are withheld by db:migrate anyway → report them informationally so a permanent, unactionable
    // "app may error" warning doesn't fire on every boot after the operator has done what it asked.
    try {
      const pending = planOps(client, desired)
      const additive = pending.filter((op) => !isDestructive(op))
      const destructive = pending.filter(isDestructive)
      if (additive.length) {
        console.warn(
          `[kestrel] SCHEMA DRIFT: the live DB is missing ${additive.length} change(s) the collections expect — ` +
          `the app may error until you run the db:migrate task. Pending:\n  - ${additive.map(describeOp).join('\n  - ')}`,
        )
      }
      if (destructive.length) {
        console.info(
          `[kestrel] schema note: ${destructive.length} table(s)/column(s) exist that the current collections no longer ` +
          `define (e.g. a disabled built-in or an unmanaged table). Not app-breaking; db:migrate withholds these unless ` +
          `you opt in ({force} / {drop:[…]}):\n  - ${destructive.map(describeOp).join('\n  - ')}`,
        )
      }
    } catch (error) {
      console.warn('[kestrel] could not check schema drift at boot:', (error as Error)?.message ?? error)
    }
    return
  }

  // SQLite is the only backend today; this is the seam where a config-driven `resolveDialect()` would go.
  // runDevSchemaSync isolates failures (logs loudly, keeps the server up) — an infeasible auto-sync must
  // not 500 every route, including the admin UI needed to fix it.
  runDevSchemaSync(client, desired, sqlite)
})
