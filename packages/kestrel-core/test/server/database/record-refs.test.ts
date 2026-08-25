import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { recordRefs } from '../../../src/server/database/record-refs.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { introspect, type IntrospectDb } from '../../../src/server/schema/introspect.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'

// better-sqlite3's `pragma()` returns `unknown`; `IntrospectDb` narrows it to `Row[]` — cast at the crossing.
function asIntrospectDb(db: Database.Database): IntrospectDb {
  return db as unknown as IntrospectDb
}

describe('record_refs table — schema-engine round-trip', () => {
  it('renders, applies and introspects with NO phantom diff (incl. both composite indexes)', () => {
    const desired = desiredSchema([recordRefs])
    const db = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desired, {}))) db.exec(stmt)
    // A second diff against the live DB must be empty → the dev auto-sync is a no-op once the table exists.
    expect(diffSchema(desired, introspect(asIntrospectDb(db)))).toEqual([])
    db.close()
  })

  it('declares the forward + reverse lookup indexes', () => {
    const idx = desiredSchema([recordRefs]).record_refs!.indexes.map((i) => i.name).sort()
    expect(idx).toEqual(['record_refs_source', 'record_refs_target'])
  })
})
