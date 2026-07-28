import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { collectPageRoutes } from './discover'

// Build an in-memory DB that mirrors the schema engine's output: every pageLike collection carries a
// partial unique index on `path` (`… WHERE path is not null`); the media `folders` registry has a plain
// unique index (no such clause); a non-pageLike collection has no `path` column at all.
function setup(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, locale TEXT NOT NULL, path TEXT, status TEXT NOT NULL DEFAULT 'draft')`)
  db.exec(`CREATE UNIQUE INDEX pages_path_locale ON pages (path, locale) WHERE path is not null`)
  db.exec(`CREATE TABLE landing (id INTEGER PRIMARY KEY, path TEXT, status TEXT NOT NULL DEFAULT 'draft')`) // pageLike, non-translatable
  db.exec(`CREATE UNIQUE INDEX landing_path ON landing (path) WHERE path is not null`)
  db.exec(`CREATE TABLE docs (id INTEGER PRIMARY KEY, path TEXT)`) // pageLike, no status column → always published
  db.exec(`CREATE UNIQUE INDEX docs_path ON docs (path) WHERE path is not null`)
  db.exec(`CREATE TABLE folders (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`) // media registry — NOT pageLike
  db.exec(`CREATE UNIQUE INDEX folders_path_unique ON folders (path)`) // plain unique index, no partial WHERE
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY, singleton_key TEXT)`) // non-pageLike (no path)
  return db
}

describe('collectPageRoutes', () => {
  it('discovers published routes across ALL pageLike collections; excludes folders, drafts, and null paths', () => {
    const db = setup()
    db.exec(`INSERT INTO pages (locale, path, status) VALUES ('en','/','published'),('en','/about','published'),('de','/ueber','published'),('en','/draft','draft'),('en',NULL,'published')`)
    db.exec(`INSERT INTO landing (path, status) VALUES ('/promo','published'),('/secret','draft')`)
    db.exec(`INSERT INTO docs (path) VALUES ('/guide')`)
    db.exec(`INSERT INTO folders (path) VALUES ('pics'),('pics/sub')`)
    const routes = collectPageRoutes(db, 'en')
    db.close()
    expect(routes).toEqual(['/', '/about', '/de/ueber', '/guide', '/promo'])
    expect(routes).not.toContain('/draft') // draft excluded
    expect(routes).not.toContain('/secret') // draft excluded (non-translatable)
    expect(routes.some((r) => r.includes('pics'))).toBe(false) // folders excluded
  })

  it('always seeds the root and returns it deduped when there are no rows', () => {
    const db = setup()
    const routes = collectPageRoutes(db, 'en')
    db.close()
    expect(routes).toEqual(['/'])
  })
})
