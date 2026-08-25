import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { defineCollection } from '../../../src/index.js'
import { buildCollection } from '../../../src/server/schema/buildCollection.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { slugSourceValue, dedupeSourcePath } from '../../../src/server/utils/page-slug.js'

const pages = buildCollection(defineCollection({ name: 'pages', mode: 'multi', translatable: true, pageLike: true, fields: { title: { type: 'text' } } }))
const posts = buildCollection(defineCollection({ name: 'posts', mode: 'multi', translatable: false, pageLike: true, fields: { title: { type: 'text' } } }))
const collections = [pages, posts]

function freshDb(seed = true) {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema(collections.map((c) => c.table)), {}))) sqlite.exec(stmt)
  const db = drizzle(sqlite)
  if (seed) db.insert(pages.table).values({ path: '/about', locale: 'en', translationGroup: 'a', title: 'About' }).run() // id1 → /about
  return db
}

describe('slugSourceValue', () => {
  it('picks the title field, else the first text field, else empty', () => {
    expect(slugSourceValue(pages.def, { title: 'Hello' })).toBe('Hello')
    const noTitle = buildCollection(defineCollection({ name: 'x', mode: 'multi', translatable: false, fields: { name: { type: 'text' }, n: { type: 'number' } } }))
    expect(slugSourceValue(noTitle.def, { name: 'First', n: 5 })).toBe('First')
    const noText = buildCollection(defineCollection({ name: 'y', mode: 'multi', translatable: false, fields: { n: { type: 'number' } } }))
    expect(slugSourceValue(noText.def, { n: 5 })).toBe('')
  })
})

// The duplicate op's seed for a pageLike collection with no slug-source text field: re-use the SOURCE's own
// path, de-duped through the SAME `-N` loop the auto-gen branch uses (so a copy lands on a free route).
describe('dedupeSourcePath', () => {
  const over = { collections, primary: 'en', prefixPrimary: false }
  it('re-uses the source path but de-dups it against the global route set (the source itself counts)', () => {
    const db = freshDb() // pages id1 → /about (its own route is taken, so a copy off it must move)
    expect(dedupeSourcePath(db, posts, { path: '/about' }, over)).toBe('/about-2')
    db.insert(posts.table).values({ path: '/about-2', title: 'x' }).run()
    expect(dedupeSourcePath(db, posts, { path: '/about' }, over)).toBe('/about-3')
  })

  it('keeps a source path whose route is free', () => {
    expect(dedupeSourcePath(freshDb(false), posts, { path: '/solo' }, over)).toBe('/solo')
  })

  it('normalizes the source path before de-duping', () => {
    expect(dedupeSourcePath(freshDb(false), posts, { path: '/Blog/' }, over)).toBe('/blog')
  })

  it('resolves under the source row locale for a translatable collection (a different-locale route is free)', () => {
    const db = freshDb() // en /about exists; a de-locale source at /about resolves to /de/about → free
    expect(dedupeSourcePath(db, pages, { path: '/about', locale: 'de' }, over)).toBe('/about')
  })

  it('returns null when the source carries no usable path', () => {
    const db = freshDb(false)
    expect(dedupeSourcePath(db, posts, { path: '' }, over)).toBeNull()
    expect(dedupeSourcePath(db, posts, { path: '   ' }, over)).toBeNull()
    expect(dedupeSourcePath(db, posts, {}, over)).toBeNull()
  })
})
