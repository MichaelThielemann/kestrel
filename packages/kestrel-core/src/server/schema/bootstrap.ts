import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BuiltCollection, CollectionDef } from '@michaelthielemann/kestrel-core'
import { ensureBuilt } from './buildCollection.js'
import { recordRefs } from '../database/record-refs.js'
import { outboxContent } from '../database/outbox-content.js'
import { revisionsTable } from '../db/revisions.js'
import { desiredSchema } from './desired.js'
import type { SchemaSnapshot } from './model.js'

/** The ONE rule for whether a discovered collection is active: built-ins (`pages`, `media`, …) can be
 *  disabled per consumer via `kestrel: { collections: { <name>: false } }`. Shared by the registry
 *  plugin AND the schema engine, so the runtime surface and the desired schema can never diverge —
 * @public
 *  a disabled built-in neither registers routes nor keeps (or creates) its table. */
export function collectionEnabled(def: CollectionDef, toggles?: Record<string, boolean>): boolean {
  return !(def.builtin && toggles?.[def.name] === false)
}

/** @public */
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
 * `outbox_content` (the content module's transactional outbox — every content write reaches it, so it is
 * provisioned unconditionally like `record_refs`, not behind a toggle) and the callers' discovered
 * standalone tables. The single definition of "what the live DB should look like", shared by the dev
 * auto-sync plugin (02.schema-sync) and the `db:migrate` task so the two can never disagree on the target
 * schema. Discovered files may default-export a plain def (consumer form) or an already-built collection.
 * @public
 */
export function desiredFromCollections(
  collections: (CollectionDef | BuiltCollection)[],
  opts: DesiredOptions = {},
): SchemaSnapshot {
  const built = collections.map(ensureBuilt).filter((c) => collectionEnabled(c.def, opts.toggles))
  const tables = [
    ...built.map((c) => c.table),
    recordRefs,
    outboxContent,
    // One `<collection>_revisions` table per enabled collection — dynamic, so compiled here rather than
    // declared statically; provisioned by the same desired-schema mechanism as the collection table itself.
    ...built.map((c) => revisionsTable(c.def.name) as AnySQLiteTable),
    ...(opts.extraTables ?? []),
  ]
  return desiredSchema(tables, new Map(built.map((c) => [c.def.name, c.def])))
}
