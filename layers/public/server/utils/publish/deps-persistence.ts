import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { publishDeps } from '../../database/publish-deps'
import type { DepsPersistence } from './deps'

/** No-op persistence: a `DepsStore` backed by it runs purely in-memory. */
const inMemoryOnly: DepsPersistence = { load: () => [], save: () => {}, remove: () => {}, clearAll: () => {} }

/**
 * SQLite-backed durable persistence for the publish deps index. Takes the drizzle db as an argument (the
 * caller passes `useDb()`) so this stays a pure function of an injected db — fully unit-testable against an
 * in-memory database, no auto-import in the module. Tags are stored JSON-encoded (a small bounded set per
 * route).
 *
 * Probes the `publish_deps` table once on creation: if it is absent (a not-yet-migrated deploy — prod never
 * auto-DDLs, so an operator must run `db:migrate`) it warns and returns an in-memory-only no-op rather than
 * crashing the boot publish + every write. Full durability (cross-restart pruning) returns once the table
 * exists. Probing once (not per-op) keeps ALL of load/save/remove/clearAll consistent — the boot publish
 * calls `save()` per route, so a resilient `load()` alone was not enough.
 */
export function createSqlitePersistence(db: BetterSQLite3Database): DepsPersistence {
  try {
    db.select().from(publishDeps).limit(1).all()
  } catch {
    console.warn('[kestrel] publish_deps table is missing — run the `db:migrate` task. Falling back to in-memory deps (no cross-restart prune until migrated).')
    return inMemoryOnly
  }
  return {
    load() {
      return db.select().from(publishDeps).all().map((r) => [r.route, JSON.parse(r.tags) as string[]] as const)
    },
    save(route, tags) {
      const json = JSON.stringify([...tags])
      db.insert(publishDeps).values({ route, tags: json }).onConflictDoUpdate({ target: publishDeps.route, set: { tags: json } }).run()
    },
    remove(route) {
      db.delete(publishDeps).where(eq(publishDeps.route, route)).run()
    },
    clearAll() {
      db.delete(publishDeps).run()
    },
  }
}
