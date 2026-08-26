import collections from '#kestrel/collections'
import schemaTables from '#kestrel/schema-tables'
import moduleManifests from '#kestrel/module-manifests'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { OwnershipManifest } from '@michaelthielemann/kestrel-contracts'
import { buildContentManifest, describeOp, desiredFromCollections, isDestructive, opTable, orderManifests, planOps, sqlite, syncSchema, useDb } from '@michaelthielemann/kestrel-core'
import type { BuiltCollection, CollectionDef, Dialect, SchemaSnapshot, SyncDb } from '@michaelthielemann/kestrel-core'
import { resolveServerKestrel, serverRuntimeConfig } from '../../utils/server-config'
// The per-module counterpart to `db:migrate` (ADR-0012): runs the SAME diff/apply engine, but scoped to
// one ownership manifest's tables at a time, in a fixed order — `content` (the collection/base schema
// other modules are conceptually layered on) first, then every discovered module manifest
// (`module-order.ts`'s `MODULE_MIGRATION_ORDER`), then an `unmanaged` catch-all for any table no
// manifest yet claims (never silently skipped). Payload/trigger mirror `db:migrate` exactly — {module:
// "media"}=one module only, otherwise every module in order; {check:true}=dry-run, {force:true}=rebuilds,
// {drop:[names]}=drop tables. Same dev/prod trigger shape as `db:migrate` (see that file's header).
type ModulePayload = { module?: string; check?: boolean; force?: boolean; drop?: string[] }
type ModuleResult =
  | { module: string; check: true; pending: string[]; destructive: string[] }
  | { module: string; applied: string[]; skipped: string[] }

function runOne(
  module: string,
  tables: readonly string[],
  client: SyncDb,
  desired: SchemaSnapshot,
  dialect: Dialect,
  p: ModulePayload,
): ModuleResult {
  if (p.check === true) {
    const ops = planOps(client, desired, dialect).filter((op) => tables.includes(opTable(op)))
    const destructive = ops.filter(isDestructive).map(describeOp)
    return { module, check: true, pending: dialect.render(ops), destructive }
  }

  const { applied, skipped } = syncSchema(client, desired, {
    allowDestructive: p.force === true,
    dropTables: Array.isArray(p.drop) ? p.drop : undefined,
    tables,
  }, dialect)
  if (skipped.length) {
    console.warn(`[kestrel] db:migrate-module(${module}) withheld ${skipped.length} destructive change(s) — opt in with {"force":true} (rebuilds) / {"drop":[…]} (drops):\n  - ${skipped.map(describeOp).join('\n  - ')}`)
  }
  console.info(`[kestrel] db:migrate-module(${module}) applied ${applied.length} statement(s)`)
  return { module, applied, skipped: skipped.map(describeOp) }
}

export default defineTask<ModuleResult[]>({
  meta: {
    name: 'db:migrate-module',
    description: 'Per-module schema migration, ordered (content → media → publishing → unmanaged). {module:"name"}=one module only, otherwise every module in order. {check}/{force}/{drop} match db:migrate.',
  },
  run({ payload }) {
    const p = (payload ?? {}) as ModulePayload
    const desired = desiredFromCollections(collections as (CollectionDef | BuiltCollection)[], {
      toggles: (serverRuntimeConfig()?.kestrel?.collections ?? resolveServerKestrel().collections) as Record<string, boolean>,
      extraTables: schemaTables as AnySQLiteTable[],
    })
    const client = (useDb() as unknown as { $client: SyncDb }).$client
    const dialect = sqlite

    const manifests = orderManifests([buildContentManifest(), ...(moduleManifests as OwnershipManifest[])])
    const claimed = new Set(manifests.flatMap((m) => m.tables))
    // The `unmanaged` bucket's table list: every table any pending op touches that no manifest claims —
    // computed up front so both `check` and apply modes scope to the SAME set (rather than an unfiltered
    // rescan, which in apply mode would re-touch already-migrated tables and in check mode would re-list
    // every module's pending ops a second time under `unmanaged`).
    const unmanagedTables = [...new Set(planOps(client, desired, dialect).map(opTable))].filter((t) => !claimed.has(t))

    if (p.module) {
      const manifest = manifests.find((m) => m.module === p.module)
      const tables = manifest ? manifest.tables : p.module === 'unmanaged' ? unmanagedTables : undefined
      if (!tables) {
        const known = [...manifests.map((m) => m.module), 'unmanaged'].join(', ')
        throw new Error(`kestrel: db:migrate-module: unknown module "${p.module}" — known: ${known}`)
      }
      return { result: [runOne(p.module, tables, client, desired, dialect, p)] }
    }

    const results = manifests.map((m) => runOne(m.module, m.tables, client, desired, dialect, p))
    results.push(runOne('unmanaged', unmanagedTables, client, desired, dialect, p))
    return { result: results }
  },
})
