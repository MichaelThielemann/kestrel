import { getTableName } from 'drizzle-orm'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { OwnershipManifest } from '@michaelthielemann/kestrel-contracts'
import { recordRefs } from '../database/record-refs.js'
import { outboxContent } from '../database/outbox-content.js'
import { outboxTableName } from './outbox.js'
import { revisionsTable, revisionsTableName } from './revisions.js'
import { allCollections, registryVersion } from '../utils/registry.js'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'

/** A CRUD call site (`create`/`list`/`getOne`/…) takes an explicit `BuiltCollection`, independent of the
 *  global registry — the registry is for HTTP routing only, and plenty of production and test code builds
 *  a collection and operates on it without ever calling `registerCollection`. So the collection currently
 *  in play (`collectionOf(ctx)`) must be unioned into the manifest alongside `allCollections()`, or an
 *  unregistered-but-legitimate collection's own table reads as foreign.
 *
 *  Bounded to a single collection, not a list: every wired call site operates on exactly one collection
 *  at a time (`collectionOf(ctx)`), so a list would only invite "any caller can widen ownership with an
 *  arbitrary set" — a reading this API never needs to support. A `BuiltCollection`'s table is always
 *  named `def.name` (`buildCollection`'s own invariant), so `extra` can only ever admit a table that is,
 *  by definition, a content collection's own table — never an arbitrary foreign one. */
function collectTables(extra: BuiltCollection | undefined): Map<string, AnySQLiteTable> {
  const byName = new Map<string, AnySQLiteTable>()
  for (const c of extra ? [...allCollections(), extra] : allCollections()) {
    byName.set(getTableName(c.table), c.table as AnySQLiteTable)
  }
  return byName
}

/**
 * The content module's table ownership (ADR-0012): every registered collection's table, plus `record_refs`
 * (the derived reference index this module now owns), plus `extra` — the one collection a caller is
 * currently operating on, if any (see `collectTables`). Collections are DYNAMIC — registered by
 * consumer code at boot, not known statically — so this manifest cannot be a fixed object like media's; it
 * is rebuilt from `allCollections()` on every call instead. Cheap (a `Map` iteration, no I/O), and safe to
 * call at request time: it never runs at plugin-init, only lazily from `useContentDbFor`/`useContentDb`
 * (mirrors `defaults.ts`'s "resolve pipelines lazily, never at plugin-init" rule for the same reason —
 * nothing may read the registry while plugins are still registering).
 *
 * `content` here means "the collection-record domain inside core" (per the Phase 4 plan) — not the whole
 * `core` layer, which also owns non-collection system tables (schema/migration bookkeeping, sessions, …)
 * that stay outside this manifest and outside the adapter.
 *
 * @public
 */
export function buildContentManifest(extra?: BuiltCollection): OwnershipManifest {
  const names = [...collectTables(extra).keys()]
  return {
    module: 'content',
    // Every collection's own `<collection>_revisions` table joins the same manifest as its content table —
    // one module, one ownership boundary, dynamic tables included (see `revisions.ts`).
    tables: ['record_refs', outboxTableName('content'), ...names, ...names.map(revisionsTableName)],
  }
}

// `revisionsTable(name)` compiles a fresh drizzle table object (columns + index) on every call — cheap
// once, but `contentTables` would otherwise rebuild one per collection on every cache miss of the caller's
// own cache (`content-db.ts`'s `useContentDbFor`). Cached per collection name, invalidated the same way
// that cache invalidates its own entry: `registryVersion()` bumping means a new/changed collection set, so
// a stale cached table object for a name that no longer means the same collection must not survive.
let revisionsTableCacheVersion: number | undefined
const revisionsTableCache = new Map<string, AnySQLiteTable>()

function cachedRevisionsTable(name: string): AnySQLiteTable {
  const version = registryVersion()
  if (revisionsTableCacheVersion !== version) {
    revisionsTableCache.clear()
    revisionsTableCacheVersion = version
  }
  let table = revisionsTableCache.get(name)
  if (!table) {
    table = revisionsTable(name)
    revisionsTableCache.set(name, table)
  }
  return table
}

/** The manifest's table objects, keyed by table name — what `makeModuleDb` needs alongside the manifest.
 * @public
 */
export function contentTables(extra?: BuiltCollection): Record<string, AnySQLiteTable> {
  const tables = collectTables(extra)
  const revisions = Object.fromEntries([...tables.keys()].map((name) => [revisionsTableName(name), cachedRevisionsTable(name)]))
  return { record_refs: recordRefs, [outboxTableName('content')]: outboxContent, ...Object.fromEntries(tables), ...revisions }
}
