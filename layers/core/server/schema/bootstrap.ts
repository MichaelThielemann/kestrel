import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BuiltCollection } from '../utils/collection-types'
import type { CollectionDef } from '../utils/defineCollection'
import { ensureBuilt } from '../../../fields/server/utils/buildCollection'
import { recordRefs } from '../database/record-refs'
import { desiredSchema } from './desired'
import type { SchemaSnapshot } from './model'

/** The ONE rule for whether a discovered collection is active: built-ins (`pages`, `media`, …) can be
 *  disabled per consumer via `kestrel: { collections: { <name>: false } }`. Shared by the registry
 *  plugin AND the schema engine, so the runtime surface and the desired schema can never diverge —
 *  a disabled built-in neither registers routes nor keeps (or creates) its table. */
export function collectionEnabled(def: CollectionDef, toggles?: Record<string, boolean>): boolean {
  return !(def.builtin && toggles?.[def.name] === false)
}

export interface DesiredOptions {
  /** Built-in collection toggles (see `collectionEnabled`). Omitted → everything discovered is desired. */
  toggles?: Record<string, boolean>
  /** Standalone (non-collection) tables owned by upper layers — discovered via `#kestrel/schema-tables`
   *  (each layer's `server/schema-tables/*.ts` default-exports one table) and passed in by the Nitro
   *  callers, so core hardcodes no upper-layer schema. `record_refs` is core-owned and always included. */
  extraTables?: AnySQLiteTable[]
}

/**
 * The desired DB schema for the discovered collections (the `#kestrel/collections` virtual, passed in
 * so this stays pure and unit-testable): every ENABLED collection's table plus core's `record_refs` and
 * the callers' discovered standalone tables. The single definition of "what the live DB should look
 * like", shared by the dev auto-sync plugin (02.schema-sync) and the `db:migrate` task so the two can
 * never disagree on the target schema. Discovered files may default-export a plain def (consumer form)
 * or an already-built collection.
 */
export function desiredFromCollections(
  collections: (CollectionDef | BuiltCollection)[],
  opts: DesiredOptions = {},
): SchemaSnapshot {
  const built = collections.map(ensureBuilt).filter((c) => collectionEnabled(c.def, opts.toggles))
  const tables = [...built.map((c) => c.table), recordRefs, ...(opts.extraTables ?? [])]
  return desiredSchema(tables, new Map(built.map((c) => [c.def.name, c.def])))
}
