import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { recordRefs } from './record-refs'
import { desiredSchema } from '../schema/desired'
import { introspect } from '../schema/introspect'
import { diffSchema } from '../schema/diff'
import { renderSqlite } from '../schema/render-sqlite'

describe('record_refs table — schema-engine round-trip', () => {
  it('renders, applies and introspects with NO phantom diff (incl. both composite indexes)', () => {
    const desired = desiredSchema([recordRefs])
    const db = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desired, {}))) db.exec(stmt)
    // A second diff against the live DB must be empty → the dev auto-sync is a no-op once the table exists.
    expect(diffSchema(desired, introspect(db))).toEqual([])
    db.close()
  })

  it('declares the forward + reverse lookup indexes', () => {
    const idx = desiredSchema([recordRefs]).record_refs!.indexes.map((i) => i.name).sort()
    expect(idx).toEqual(['record_refs_source', 'record_refs_target'])
  })
})
