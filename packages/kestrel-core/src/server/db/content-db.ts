import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Effect } from 'effect'
import { makeModuleDb, type ModuleDbService } from './module-db.js'
import { buildContentManifest, contentTables } from './content-manifest.js'
import { registryVersion } from '../utils/registry.js'
import { useDb } from '../utils/db.js'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'

/** The `db` surface content call sites take instead of the raw drizzle instance — enforced against the
 * @public
 *  content ownership manifest in dev/test, a zero-cost passthrough in prod (see `makeModuleDb`). */
export type ContentDb = ModuleDbService['db']

let cachedClient: Database.Database | undefined
let cachedVersion: number | undefined
let cachedExtraKey: string | undefined
let cached: ModuleDbService | undefined

/** The content module's `<Module>Db` adapter (ADR-0012), built from `db`'s raw `better-sqlite3.Database`
 *  handle (see `media-db.ts`'s TSDoc for why `.$client` is the right escape hatch here). Cached per
 *  underlying client, per collection-registry generation (`registryVersion()` — an O(1) counter, not a
 *  fingerprint recomputed from `allCollections()` on every call: this runs on the `reindexRefs` after-step
 *  of every write, so the cache check itself has to stay off the perf-budget's critical path), and per
 *  `extra` set (see below): a real boot builds it once; a test that swaps its db (`globalThis.useDb` stub)
 *  or its registered collections (`registerCollection`/`clearRegistry`) gets a correctly re-scoped adapter
 *  instead of a stale one.
 *
 *  A pipeline step (or any caller with a `ctx`/injected db) MUST derive from that same db — via
 *  `useContentDbFor(dbOf(ctx))` — rather than reaching for {@link useContentDb}'s global lookup, for the
 *  same reason `useMediaDbFor` documents: the two can diverge under a trusted call carrying its own
 *  `options.db`. Some call sites (an after-step also reachable with no `ctx.ports.db`, e.g. `reindexRefs`
 *  run via `runWriteAfterStepsSync`) genuinely have no port to derive from and fall back to the global
 *  lookup themselves.
 *
 *  `extra` carries the one collection the caller is currently operating on (typically `collectionOf(ctx)`)
 *  — a CRUD call site takes an explicit `BuiltCollection` independent of the global registry, so a
 *  legitimately-in-play but unregistered collection's own table must still count as owned (see
 *  `content-manifest.ts`'s `collectTables`). Keyed by name only (not folded into `registryVersion()`,
 *  which the registry itself does not know about `extra`), so passing a different `extra` correctly
 * @public
 *  rebuilds instead of returning a stale adapter. */
export function useContentDbFor(db: BetterSQLite3Database, extra?: BuiltCollection): ModuleDbService {
  const client = (db as unknown as { $client: Database.Database }).$client
  const version = registryVersion()
  const extraKey = extra?.name ?? ''
  if (!cached || cachedClient !== client || cachedVersion !== version || cachedExtraKey !== extraKey) {
    const { layer, tag } = makeModuleDb(buildContentManifest(extra), client, contentTables(extra))
    cached = Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))
    cachedClient = client
    cachedVersion = version
    cachedExtraKey = extraKey
  }
  return cached
}

/** {@link useContentDbFor} against the shared `useDb()` singleton — for call sites with no `ctx`/injected
 *  db to derive from. A pipeline step reachable via `dbOf(ctx)` should use `useContentDbFor(dbOf(ctx))`
 * @public
 *  instead (see that TSDoc). */
export function useContentDb(): ModuleDbService {
  return useContentDbFor(useDb())
}
