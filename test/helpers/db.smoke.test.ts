import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from './db'

describe('createTestDb', () => {
  it('applies migrations and creates the pages table', () => {
    const db = createTestDb()
    const rows = db.all(sql`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pages','posts','settings')`)
    expect((rows as { name: string }[]).map((r) => r.name).sort()).toEqual(['pages', 'posts', 'settings'])
  })
})
