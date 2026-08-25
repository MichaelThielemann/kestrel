import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { desiredSchema, diffSchema, introspect } from '@kestrel/core'
import * as schema from './schema'

// Every layer's committed table lives here (this file, not any one layer, is the app's full
// schema aggregate) — this test needs the whole set to confirm the migrations stay in sync. Every
// exported table, discovered structurally rather than named one by one: `./schema` also re-exports
// non-table bindings (e.g. the publishing module's own read/write functions), which `is` filters out.
describe('desiredSchema — parity with the committed drizzle-kit migrations', () => {
  it('desired schema of the live tables equals the migrated DB → boot auto-sync is a no-op on built-ins', () => {
    const tables = Object.values(schema).filter((v): v is SQLiteTable => is(v, SQLiteTable))
    const desired = desiredSchema(tables)
    const sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: resolve(process.cwd(), 'server/database/migrations') })
    expect(diffSchema(desired, introspect(sqlite))).toEqual([])
    sqlite.close()
  })
})
