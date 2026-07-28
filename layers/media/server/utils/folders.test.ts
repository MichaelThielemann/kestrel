import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { ensureFolder } from './folders'
import { createTestDb } from '../../../../test/helpers/db'

const paths = (db: ReturnType<typeof createTestDb>) =>
  (db.all(sql`select path from folders order by path`) as { path: string }[]).map((r) => r.path)

describe('ensureFolder', () => {
  it('creates the folder and all missing ancestors, idempotently', () => {
    const db = createTestDb()
    ensureFolder(db, 'pages/home/gallery')
    expect(paths(db)).toEqual(['pages', 'pages/home', 'pages/home/gallery'])
    ensureFolder(db, 'pages/home/gallery') // idempotent
    ensureFolder(db, 'pages/home') // already exists
    expect(paths(db)).toEqual(['pages', 'pages/home', 'pages/home/gallery'])
  })
  it('sanitizes the path and ignores the root', () => {
    const db = createTestDb()
    ensureFolder(db, '/Seite A/../x/') // sanitizeFolder drops '..', cleans segments
    expect(paths(db)).toEqual(['Seite_A', 'Seite_A/x'])
    ensureFolder(db, '')
    expect(paths(db)).toEqual(['Seite_A', 'Seite_A/x'])
  })
})
