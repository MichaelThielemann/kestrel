import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Effect } from 'effect'
import { makeModuleDb, rawSqliteClientOf, useDb, type ModuleDbService } from '@michaelthielemann/kestrel-core'
import { mediaOwnershipManifest } from './manifest.js'
import { media } from '../collections/media.js'
import { mediaSettings } from '../collections/media-settings.js'
import { folders } from '../database/folders.js'

/** The `db` surface every media call site takes instead of the raw drizzle instance — enforced against
 *  `mediaOwnershipManifest` in dev/test, a zero-cost passthrough in prod (see `makeModuleDb`).
 * @public
 */
export type MediaDb = ModuleDbService['db']

let cachedClient: Database.Database | undefined
let cached: ModuleDbService | undefined

/** The media module's `<Module>Db` adapter (ADR-0012), built from `db`'s raw `better-sqlite3.Database`
 *  handle (drizzle exposes it as `.$client` — undocumented on `BetterSQLite3Database`'s public type, but
 *  this is exactly the shape `test/helpers/pipeline-route.ts`/`media-upload.test.ts` already reach for).
 *  Cached per underlying client so a real boot builds it once, while a test that swaps its db gets a
 *  fresh adapter too — `makeModuleDb`'s `Layer.succeed` carries no acquire/release, so rebuilding on a
 *  client change and otherwise reusing the cached service are equivalent.
 *
 *  A pipeline step (or any caller with a `ctx`/injected db, e.g. a trusted call carrying its own
 *  `options.db`) MUST derive from that same db — via `useMediaDbFor(dbOf(ctx))` — rather than reaching
 *  for {@link useMediaDb}'s global lookup: the two can diverge (a trusted call's injected db is not
 *  necessarily the `useDb()` singleton), and deriving from the port keeps that injection seam meaningful
 *  instead of silently bypassing it.
 * @public
 */
export function useMediaDbFor(db: BetterSQLite3Database): ModuleDbService {
  const client = (db as unknown as { $client: Database.Database }).$client
  if (!cached || cachedClient !== client) {
    const { layer, tag } = makeModuleDb(mediaOwnershipManifest, client, { media, media_settings: mediaSettings, folders })
    cached = Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))
    cachedClient = client
  }
  return cached
}

/** {@link useMediaDbFor} against the shared `useDb()` singleton — for call sites with no `ctx`/injected
 *  db to derive from (a Nitro task, a plugin hook, on-demand middleware). A pipeline step reachable via
 *  `dbOf(ctx)` should use `useMediaDbFor(dbOf(ctx))` instead (see that TSDoc).
 * @public
 */
export function useMediaDb(): ModuleDbService {
  return useMediaDbFor(useDb())
}

/**
 * The raw connection a `MediaDb` was built from — for `media-write.ts`'s `emitMediaOutbox` (ADR-0023's
 * ownership exemption), which needs the exact connection the write it is pairing with actually runs on,
 * not "whichever db `useDb()` currently returns" (the two can diverge — see `useMediaDbFor`'s own TSDoc).
 *
 * Resolves in one of two ways, both exact — never a "most recently built" guess:
 * - `db` IS (or wraps) a raw `BetterSQLite3Database` already — a test that hands `deleteAffected`/etc. a
 *   plain `createTestDb()` result directly, duck-typed against `MediaDb`'s surface, exposes `.$client`
 *   itself; that IS the connection, no lookup needed.
 * - Otherwise `db` is the checked adapter `makeModuleDb` returns — `rawSqliteClientOf` recovers its
 *   connection by the object's own identity (see that function's TSDoc), never a shared "last built" cache.
 *
 * Throws rather than silently falling back to a different connection — the seam's whole point is that its
 * outbox write and the caller's row write land in the SAME transaction; guessing wrong here would write the
 * envelope into an unrelated database outside any transaction, silently.
 * @public
 */
export function sqliteClientOfMediaDb(db: MediaDb): Database.Database {
  const asRaw = db as unknown as { $client?: Database.Database }
  if (asRaw.$client) return asRaw.$client
  const viaAdapter = rawSqliteClientOf(db)
  if (viaAdapter) return viaAdapter
  throw new Error('[kestrel] media-db: cannot resolve the raw sqlite connection for this MediaDb — pass either a raw BetterSQLite3Database or one built via makeModuleDb/useMediaDbFor')
}
