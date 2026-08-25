import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { allCollections, ensureRevisionsTable } from '@kestrel/core'
const migrationsFolder = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'server/database/migrations')

/** `<collection>_revisions` tables have no committed migration (they are dynamic, provisioned in
 *  production by the schema layer — see `revisions.ts`'s own TSDoc), so a test DB provisions them here for
 *  whatever is already registered at call time — mirroring what `desiredFromCollections`/schema-sync does
 *  for a real boot. Registration must happen before `createTestDb()`, as every existing test already does. */
export function createTestDb(): BetterSQLite3Database {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  for (const c of allCollections()) ensureRevisionsTable(sqlite, c.def.name)
  return db
}
