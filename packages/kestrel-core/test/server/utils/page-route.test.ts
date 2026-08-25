import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { defineCollection } from '../../../src/index.js'
import { buildCollection } from '../../../src/server/schema/buildCollection.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { routeOf, findRouteConflict } from '../../../src/server/utils/page-route.js'

const pages = buildCollection(defineCollection({ name: 'pages', mode: 'multi', translatable: true, pageLike: true, fields: { title: { type: 'text' } } }))
const posts = buildCollection(defineCollection({ name: 'posts', mode: 'multi', translatable: false, pageLike: true, fields: { title: { type: 'text' } } }))
const authors = buildCollection(defineCollection({ name: 'authors', mode: 'multi', translatable: false, fields: { name: { type: 'text' } } })) // NOT pageLike
const collections = [pages, posts, authors]

function freshDb() {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema(collections.map((c) => c.table)), {}))) sqlite.exec(stmt)
  const db = drizzle(sqlite)
  db.insert(pages.table).values({ path: '/about', locale: 'en', translationGroup: 'a', title: 'About' }).run()        // id1 → /about
  db.insert(pages.table).values({ path: '/ueber-uns', locale: 'de', translationGroup: 'a', title: 'Über uns' }).run() // id2 → /de/ueber-uns
  db.insert(posts.table).values({ path: '/news', title: 'News' }).run()                                               // id1 → /news
  db.insert(posts.table).values({ path: '/de/ueber-uns', title: 'literal' }).run()                                    // id2 → /de/ueber-uns (literal)
  return db
}

describe('routeOf', () => {
  it('translatable rows localize; non-translatable rows are always primary (unprefixed)', () => {
    expect(routeOf({ path: '/about', locale: 'en' }, true, 'en')).toBe('/about')
    expect(routeOf({ path: '/about', locale: 'de' }, true, 'en')).toBe('/de/about')
    expect(routeOf({ path: '/about', locale: 'de' }, false, 'en')).toBe('/about') // non-translatable ignores locale
    expect(routeOf({ path: null }, true, 'en')).toBeNull()
    expect(routeOf({ path: '' }, true, 'en')).toBeNull()
  })
})

describe('findRouteConflict — global per-locale resolved-route uniqueness', () => {
  it('detects a cross-collection collision on the same resolved route', () => {
    const db = freshDb()
    // a new posts record wanting /about collides with the existing en page that resolves to /about
    expect(findRouteConflict(db, '/about', 'en', collections, { collection: 'posts', id: null })).toEqual({ collection: 'pages', id: 1 })
  })

  it('allows the same bare slug in a different locale (different resolved route)', () => {
    const db = freshDb()
    expect(findRouteConflict(db, '/de/about', 'en', collections, { collection: 'posts', id: null })).toBeNull()
  })

  it('catches the non-injective alias: a literal /de/ueber-uns vs a de-locale /ueber-uns', () => {
    const db = freshDb()
    // both posts id2 (literal /de/ueber-uns) and pages id2 (de /ueber-uns) resolve to /de/ueber-uns
    expect(findRouteConflict(db, '/de/ueber-uns', 'en', collections, { collection: 'pages', id: 99 })).toEqual({ collection: 'pages', id: 2 })
    expect(findRouteConflict(db, '/de/ueber-uns', 'en', collections, { collection: 'pages', id: 2 })).toEqual({ collection: 'posts', id: 2 })
  })

  it('excludes the record being saved (its own route is never a self-conflict)', () => {
    const db = freshDb()
    expect(findRouteConflict(db, '/about', 'en', collections, { collection: 'pages', id: 1 })).toBeNull()
  })

  it('ignores non-pageLike collections', () => {
    const db = freshDb()
    expect(findRouteConflict(db, '/news', 'en', collections, { collection: 'posts', id: 1 })).toBeNull() // only posts id1 owns /news, and it is excluded
  })

  it('with prefixPrimary, uniqueness is on the /<primary>-prefixed route (a bare primary path still collides)', () => {
    // seeded pages /about (en) resolves to /en/about under prefixPrimary; a target route of /en/about collides.
    const db = freshDb()
    expect(findRouteConflict(db, '/en/about', 'en', collections, { collection: 'posts', id: null }, true)).toEqual({ collection: 'pages', id: 1 })
    // the bare (unprefixed) route is free under prefixPrimary — it no longer resolves to anything.
    expect(findRouteConflict(db, '/about', 'en', collections, { collection: 'posts', id: null }, true)).toBeNull()
  })
})
