import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const migrationsFolder = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'server/database/migrations')

export function createTestDb(): BetterSQLite3Database {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  return db
}
