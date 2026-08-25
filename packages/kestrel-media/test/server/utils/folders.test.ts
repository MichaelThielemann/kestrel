import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { ensureFolder } from '../../../src/server/utils/folders.js'
import { createTestDb } from '../../../../../test/helpers/db.js'
import type { MediaDb } from '../../../src/server/db/media-db.js'

function asMediaDb(db: ReturnType<typeof createTestDb>): MediaDb {
  return db as unknown as MediaDb
}

const paths = (db: ReturnType<typeof createTestDb>) =>
  (db.all(sql`select path from folders order by path`) as { path: string }[]).map((r) => r.path)

describe('ensureFolder', () => {
  it('creates the folder and all missing ancestors, idempotently', () => {
    const db = createTestDb()
    ensureFolder(asMediaDb(db), 'pages/home/gallery')
    expect(paths(db)).toEqual(['pages', 'pages/home', 'pages/home/gallery'])
    ensureFolder(asMediaDb(db), 'pages/home/gallery')
    ensureFolder(asMediaDb(db), 'pages/home')
    expect(paths(db)).toEqual(['pages', 'pages/home', 'pages/home/gallery'])
  })
  it('sanitizes the path and ignores the root', () => {
    const db = createTestDb()
    ensureFolder(asMediaDb(db), '/Seite A/../x/') // sanitizeFolder drops '..', cleans segments
    expect(paths(db)).toEqual(['Seite_A', 'Seite_A/x'])
    ensureFolder(asMediaDb(db), '')
    expect(paths(db)).toEqual(['Seite_A', 'Seite_A/x'])
  })
})
