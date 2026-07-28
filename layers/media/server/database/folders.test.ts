import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from '../../../../test/helpers/db'

describe('folders migration', () => {
  it('creates the folders table with a unique path', () => {
    const db = createTestDb()
    const now = Date.now()
    db.run(sql`insert into folders (path, created_at, updated_at) values ('pages', ${now}, ${now})`)
    let threw = false
    try {
      db.run(sql`insert into folders (path, created_at, updated_at) values ('pages', ${now}, ${now})`)
    }
    catch (err: unknown) {
      threw = true
      const msg = err instanceof Error
        ? (err.message + (err.cause instanceof Error ? ' ' + err.cause.message : ''))
        : String(err)
      expect(msg).toMatch(/UNIQUE/)
    }
    expect(threw).toBe(true)
    const rows = db.all(sql`select path from folders`) as { path: string }[]
    expect(rows.map((r) => r.path)).toEqual(['pages'])
  })
})
