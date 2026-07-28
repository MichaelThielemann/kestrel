import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { defineCollection } from './defineCollection'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { desiredSchema } from '../schema/desired'
import { diffSchema } from '../schema/diff'
import { renderSqlite } from '../schema/render-sqlite'
import { resolvePageSlug, slugSourceValue, dedupeSourcePath } from './page-slug'

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

const ctx = (over: Record<string, unknown> = {}) => ({ id: null, existing: null, collections, primary: 'en', prefixPrimary: false, ...over } as never)

describe('slugSourceValue', () => {
  it('picks the title field, else the first text field, else empty', () => {
    expect(slugSourceValue(pages.def, { title: 'Hello' })).toBe('Hello')
    const noTitle = buildCollection(defineCollection({ name: 'x', mode: 'multi', translatable: false, fields: { name: { type: 'text' }, n: { type: 'number' } } }))
    expect(slugSourceValue(noTitle.def, { name: 'First', n: 5 })).toBe('First')
    const noText = buildCollection(defineCollection({ name: 'y', mode: 'multi', translatable: false, fields: { n: { type: 'number' } } }))
    expect(slugSourceValue(noText.def, { n: 5 })).toBe('')
  })
})

describe('resolvePageSlug', () => {
  it('is a no-op for a non-pageLike collection', () => {
    const data = buildCollection(defineCollection({ name: 'd', mode: 'multi', translatable: false, fields: { title: { type: 'text' } } }))
    const v: Record<string, unknown> = { title: 'X' }
    resolvePageSlug(freshDb(false), data, v, ctx())
    expect('path' in v).toBe(false)
  })

  it('auto-generates the slug from the title when blank', () => {
    const v: Record<string, unknown> = { title: 'Über uns', locale: 'en' }
    resolvePageSlug(freshDb(false), pages, v, ctx())
    expect(v.path).toBe('/uber-uns')
  })

  it('rejects when there is neither a slug nor a title to derive one from (400)', () => {
    const v: Record<string, unknown> = { locale: 'en' }
    expect(() => resolvePageSlug(freshDb(false), pages, v, ctx())).toThrowError(/slug is required|Validation/)
  })

  it('normalizes an explicit slug (single leading slash + lowercase)', () => {
    const v: Record<string, unknown> = { title: 'X', path: 'About-Us', locale: 'en' }
    resolvePageSlug(freshDb(false), pages, v, ctx())
    expect(v.path).toBe('/about-us')
  })

  it('strips a trailing slash and collapses duplicate/empty segments to the resolver-canonical form', () => {
    // The render-side resolver drops trailing slashes + empty segments; if the stored path keeps them the
    // page 404s on the static site and the sitemap advertises a dead URL. Normalize to the same shape.
    const trail: Record<string, unknown> = { title: 'X', path: '/blog/', locale: 'en' }
    resolvePageSlug(freshDb(false), pages, trail, ctx())
    expect(trail.path).toBe('/blog')
    const messy: Record<string, unknown> = { title: 'Y', path: '//a//b/', locale: 'en' }
    resolvePageSlug(freshDb(false), pages, messy, ctx())
    expect(messy.path).toBe('/a/b')
  })

  it('rejects an explicit slug that collides GLOBALLY across collections (409)', () => {
    const v: Record<string, unknown> = { title: 'About', path: '/about' } // posts wanting /about, taken by the en page
    expect(() => resolvePageSlug(freshDb(), posts, v, ctx())).toThrowError(/already in use|409/)
  })

  it('de-duplicates an AUTO-generated slug against the global route set (-2, -3, …)', () => {
    const db = freshDb() // en /about exists (pages id1)
    const v: Record<string, unknown> = { title: 'About' }
    resolvePageSlug(db, posts, v, ctx())
    expect(v.path).toBe('/about-2')
    db.insert(posts.table).values({ path: '/about-2', title: 'x' }).run()
    const v2: Record<string, unknown> = { title: 'About' }
    resolvePageSlug(db, posts, v2, ctx())
    expect(v2.path).toBe('/about-3')
  })

  it('allows the same bare slug in a different locale (different resolved route)', () => {
    const v: Record<string, unknown> = { title: 'About', path: '/about', locale: 'de' } // → /de/about, free
    resolvePageSlug(freshDb(), pages, v, ctx())
    expect(v.path).toBe('/about')
  })

  it('on update, excludes the record itself (re-saving the same path is not a self-conflict)', () => {
    const v: Record<string, unknown> = { path: '/about', locale: 'en' }
    resolvePageSlug(freshDb(), pages, v, ctx({ id: 1, existing: { id: 1, locale: 'en', path: '/about', title: 'About' } }))
    expect(v.path).toBe('/about')
  })

  it('on update with a blank path, auto-generates from the existing title', () => {
    const v: Record<string, unknown> = { path: '' } // cleared slug
    resolvePageSlug(freshDb(false), pages, v, ctx({ id: 1, existing: { id: 1, locale: 'en', title: 'Contact Us' } }))
    expect(v.path).toBe('/contact-us')
  })

  it('with prefixPrimary, uniqueness is on the /<primary>-prefixed route (a bare primary slug still collides)', () => {
    // seeded pages /about (en) resolves to /en/about under prefixPrimary; a new posts /about → /en/about → taken
    const v: Record<string, unknown> = { title: 'About' }
    resolvePageSlug(freshDb(), posts, v, ctx({ prefixPrimary: true }))
    expect(v.path).toBe('/about-2')
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
