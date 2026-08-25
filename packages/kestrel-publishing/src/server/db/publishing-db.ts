import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Effect } from 'effect'
import { makeModuleDb, useDb, type ModuleDbService } from '@kestrel/core'
import { publishingOwnershipManifest } from './manifest.js'
import { publishDeps } from '../database/publish-deps.js'
import { publishStatus } from '../database/publish-status.js'
import { publishRuns } from '../database/publish-runs.js'
import { publishedSnapshots } from './snapshots.js'

/** The `db` surface publishing call sites take instead of the raw drizzle instance — enforced against
 *  `publishingOwnershipManifest` in dev/test, a zero-cost passthrough in prod (see `makeModuleDb`).
 * @public
 */
export type PublishingDb = ModuleDbService['db']

let cachedClient: Database.Database | undefined
let cached: ModuleDbService | undefined

/** The publishing module's `<Module>Db` adapter (ADR-0012), built from `db`'s raw `better-sqlite3.Database`
 *  handle (see `media-db.ts`'s TSDoc for why `.$client` is the right escape hatch here). Cached per
 *  underlying client so a real boot builds it once, while a test that swaps its db (`globalThis.useDb`
 *  stub) gets a correctly re-scoped adapter instead of a stale one.
 *
 *  Every real publishing call site (`deps-persistence.ts`, `publish-status.ts`, the runtime publisher, the
 *  publish pipeline) runs OUTSIDE a collection-scoped pipeline context — the publish/publishStatus
 *  pipelines carry no `collection`, so `ctx.ports.db` is always `null` there (`api/[...path].ts` only sets
 *  it when a collection is present), and the runtime publisher/queue run detached from any request
 *  context at all. There is therefore no `dbOf(ctx)` port to derive from anywhere in this module — unlike
 *  media/content, every call site legitimately uses the global lookup below.
 * @public
 */
export function usePublishingDbFor(db: BetterSQLite3Database): ModuleDbService {
  const client = (db as unknown as { $client: Database.Database }).$client
  if (!cached || cachedClient !== client) {
    const { layer, tag } = makeModuleDb(publishingOwnershipManifest, client, { publish_deps: publishDeps, publish_status: publishStatus, publish_runs: publishRuns, published_snapshots: publishedSnapshots })
    cached = Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))
    cachedClient = client
  }
  return cached
}

/** {@link usePublishingDbFor} against the shared `useDb()` singleton — the only lookup this module's call
 *  sites need (see the TSDoc above for why no `ctx`-derived variant is wired).
 * @public
 */
export function usePublishingDb(): ModuleDbService {
  return usePublishingDbFor(useDb())
}
