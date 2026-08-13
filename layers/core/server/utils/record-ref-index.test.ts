import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { recordRefs } from '../database/record-refs'
import { maintainRecordRefs, deadTargets, collectionMayReference, deriveLocatedDeadRefs, recordDeadRefs, findReferrers, findReferrersForMany, findBrokenRefs } from './record-ref-index'
import { list } from './crud'
import { desiredSchema } from '../schema/desired'
import { diffSchema } from '../schema/diff'
import { renderSqlite } from '../schema/render-sqlite'
import { defineCollection, type FieldDef } from './defineCollection'
import { clearRegistry, registerCollection } from './registry'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { registerBlock, clearBlocks } from '../../../fields/server/utils/defineBlock'

function freshDb(): BetterSQLite3Database {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([recordRefs]), {}))) sqlite.exec(stmt)
  return drizzle(sqlite)
}

function edges(db: BetterSQLite3Database) {
  return db.select().from(recordRefs).all()
    .map((r) => `${r.sourceColl}:${r.sourceId}→${r.targetColl}:${r.targetId}`)
    .sort()
}

const pages = defineCollection({
  name: 'pages', mode: 'multi', translatable: false,
  fields: { author: { type: 'relation', relation: { collection: 'users' } }, cover: { type: 'media' } },
})

describe('maintainRecordRefs', () => {
  it('inserts the extracted edges on create (single relation via `${name}Id`, media)', () => {
    const db = freshDb()
    maintainRecordRefs(db, { def: pages, before: null, after: { id: 1, authorId: 5, coverId: 9 } })
    expect(edges(db)).toEqual(['pages:1→media:9', 'pages:1→users:5'])
  })

  it('replaces a source\'s edges on update — old gone, new in', () => {
    const db = freshDb()
    maintainRecordRefs(db, { def: pages, before: null, after: { id: 1, authorId: 5, coverId: 9 } })
    maintainRecordRefs(db, { def: pages, before: { id: 1, authorId: 5, coverId: 9 }, after: { id: 1, authorId: 8, coverId: null } })
    expect(edges(db)).toEqual(['pages:1→users:8'])
  })

  it('removes the source\'s edges on delete', () => {
    const db = freshDb()
    maintainRecordRefs(db, { def: pages, before: null, after: { id: 1, authorId: 5 } })
    maintainRecordRefs(db, { def: pages, before: { id: 1, authorId: 5 }, after: null })
    expect(edges(db)).toEqual([])
  })

  it('only touches the written source — other records\' edges survive a re-save', () => {
    const db = freshDb()
    maintainRecordRefs(db, { def: pages, before: null, after: { id: 1, authorId: 5 } })
    maintainRecordRefs(db, { def: pages, before: null, after: { id: 2, authorId: 6 } })
    maintainRecordRefs(db, { def: pages, before: { id: 1, authorId: 5 }, after: { id: 1, authorId: 7 } })
    expect(edges(db)).toEqual(['pages:1→users:7', 'pages:2→users:6'])
  })

  it('scopes edges by source collection (same id in two collections does not collide)', () => {
    const db = freshDb()
    const posts = defineCollection({ name: 'posts', mode: 'multi', translatable: false, fields: { author: { type: 'relation', relation: { collection: 'users' } } } })
    maintainRecordRefs(db, { def: pages, before: null, after: { id: 1, authorId: 5 } })
    maintainRecordRefs(db, { def: posts, before: null, after: { id: 1, authorId: 6 } })
    expect(edges(db)).toEqual(['pages:1→users:5', 'posts:1→users:6'])
  })

  it('records nothing when a record has no references', () => {
    const db = freshDb()
    const plain = defineCollection({ name: 'plain', mode: 'multi', translatable: false, fields: { title: { type: 'text' } } })
    maintainRecordRefs(db, { def: plain, before: null, after: { id: 1, title: 'x' } })
    expect(edges(db)).toEqual([])
  })

  it('indexes edges nested in block content', () => {
    clearBlocks()
    registerBlock({ name: 'hero', fields: { cta: { type: 'link' }, img: { type: 'media' } } })
    const db = freshDb()
    const withBlocks = defineCollection({ name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    maintainRecordRefs(db, {
      def: withBlocks, before: null,
      after: { id: 3, content: [{ id: 'b1', type: 'hero', props: { cta: { type: 'internal', collection: 'posts', id: 4 }, img: 8 } }] },
    })
    expect(edges(db)).toEqual(['pages:3→media:8', 'pages:3→posts:4'])
    clearBlocks()
  })
})

// `users` has no status column (deleted-only deadness); `pages` has a status column + a relation field.
const usersC = buildCollection(defineCollection({ name: 'users', mode: 'multi', translatable: false, fields: { name: { type: 'text' } } }))
const pagesC = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true,
  fields: { title: { type: 'text' }, author: { type: 'relation', relation: { collection: 'users' } } },
}))

function setupTargets(): BetterSQLite3Database {
  clearRegistry()
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([recordRefs, usersC.table, pagesC.table]), {}))) sqlite.exec(stmt)
  const db = drizzle(sqlite)
  registerCollection(usersC)
  registerCollection(pagesC)
  // users 10 exists; pages 1 published, 2 draft. (users 11, pages 3 are absent → "missing".)
  db.run(sql`INSERT INTO users (id, name, created_at, updated_at) VALUES (10, 'U', 0, 0)`)
  db.run(sql`INSERT INTO pages (id, status, created_at, updated_at) VALUES (1, 'published', 0, 0), (2, 'draft', 0, 0)`)
  return db
}

describe('deadTargets — batched dead-ness classification', () => {
  beforeEach(() => clearRegistry())

  it('flags missing rows, unpublished (status-bearing) rows, and unknown collections; spares alive ones', () => {
    const db = setupTargets()
    const dead = deadTargets(db, [
      { collection: 'pages', id: 1 }, // published → alive
      { collection: 'pages', id: 2 }, // draft → unpublished
      { collection: 'pages', id: 3 }, // gone → missing
      { collection: 'users', id: 10 }, // exists, no status column → alive
      { collection: 'users', id: 11 }, // gone → missing
      { collection: 'ghost', id: 5 }, // unknown collection → missing
    ])
    expect(Object.fromEntries(dead)).toEqual({
      'pages:2': 'unpublished',
      'pages:3': 'missing',
      'users:11': 'missing',
      'ghost:5': 'missing',
    })
  })
})

describe('collectionMayReference', () => {
  it('is true for relation/media/link/richtext, repeaters holding one, or blocks; false otherwise', () => {
    const may = (fields: Record<string, FieldDef>, blocks = false) =>
      collectionMayReference(defineCollection({ name: 'x', mode: 'multi', translatable: false, ...(blocks ? { blocks: { enabled: true } } : {}), fields }))
    expect(may({ a: { type: 'relation', relation: { collection: 'u' } } })).toBe(true)
    expect(may({ a: { type: 'media' } })).toBe(true)
    expect(may({ a: { type: 'link' } })).toBe(true)
    expect(may({ a: { type: 'richtext' } })).toBe(true)
    expect(may({ a: { type: 'repeater', options: { fields: { b: { type: 'link' } } } } })).toBe(true)
    expect(may({}, true)).toBe(true)
    expect(may({ a: { type: 'text' }, b: { type: 'repeater', options: { fields: { c: { type: 'number' } } } } })).toBe(false)
  })
})

describe('deriveLocatedDeadRefs / recordDeadRefs', () => {
  beforeEach(() => clearRegistry())

  it('returns only the stale refs, located, with a reason', () => {
    const db = setupTargets()
    // author 11 is missing → dead; a second record-style call with author 10 (alive) → empty.
    expect(deriveLocatedDeadRefs(db, pagesC.def, { id: 99, authorId: 11 })).toEqual([
      { field: 'author', collection: 'users', id: 11, reason: 'missing' },
    ])
    expect(deriveLocatedDeadRefs(db, pagesC.def, { id: 99, authorId: 10 })).toEqual([])
  })

  it('recordDeadRefs loads the row by id then derives (empty for a missing row)', () => {
    const db = setupTargets()
    db.run(sql`INSERT INTO pages (id, status, author_id, created_at, updated_at) VALUES (50, 'published', 11, 0, 0)`)
    expect(recordDeadRefs(db, pagesC, 50)).toEqual([{ field: 'author', collection: 'users', id: 11, reason: 'missing' }])
    expect(recordDeadRefs(db, pagesC, 9999)).toEqual([])
  })
})

describe('list() — $hasDeadRefs sidecar', () => {
  beforeEach(() => clearRegistry())

  it('marks rows whose references point at a dead target, leaving healthy rows false', () => {
    const db = setupTargets()
    db.run(sql`INSERT INTO pages (id, status, author_id, created_at, updated_at) VALUES (100, 'published', 10, 0, 0), (101, 'published', 11, 0, 0)`)
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 100, authorId: 10 } })
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 101, authorId: 11 } })

    const byId = Object.fromEntries(list(db, pagesC, {}).data.map((r) => [r.id, r.$hasDeadRefs]))
    expect(byId[100]).toBe(false) // author 10 alive
    expect(byId[101]).toBe(true) // author 11 missing
  })

  it('does not attach the sidecar on published-scope (public) reads', () => {
    const db = setupTargets()
    db.run(sql`INSERT INTO pages (id, status, author_id, created_at, updated_at) VALUES (101, 'published', 11, 0, 0)`)
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 101, authorId: 11 } })
    const [row] = list(db, pagesC, {}, true).data // publishedOnly = true
    expect(row?.$hasDeadRefs).toBeUndefined()
  })
})

describe('findReferrers / findBrokenRefs — reverse lookups', () => {
  beforeEach(() => clearRegistry())

  it('findReferrers lists the distinct records that point at a target', () => {
    const db = setupTargets()
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 100, authorId: 10 } })
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 101, authorId: 10 } })
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 102, authorId: 99 } }) // points elsewhere
    expect(findReferrers(db, 'users', 10).map((r) => `${r.collection}:${r.id}`).sort()).toEqual(['pages:100', 'pages:101'])
    expect(findReferrers(db, 'users', 77)).toEqual([]) // nobody links here
  })

  it('findBrokenRefs returns only edges whose target is dead, with the reason (missing + unpublished)', () => {
    const db = setupTargets()
    const linkerDef = defineCollection({ name: 'linker', mode: 'multi', translatable: false, fields: { ref: { type: 'relation', relation: { collection: 'pages' } } } })
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 100, authorId: 11 } }) // → users:11 (missing)
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 101, authorId: 10 } }) // → users:10 (alive)
    maintainRecordRefs(db, { def: linkerDef, before: null, after: { id: 5, refId: 2 } }) // → pages:2 (draft → unpublished)
    maintainRecordRefs(db, { def: linkerDef, before: null, after: { id: 6, refId: 1 } }) // → pages:1 (published → alive)
    const broken = findBrokenRefs(db)
      .map((b) => `${b.source.collection}:${b.source.id}→${b.target.collection}:${b.target.id}(${b.reason})`)
      .sort()
    expect(broken).toEqual(['linker:5→pages:2(unpublished)', 'pages:100→users:11(missing)'])
  })

  it('findBrokenRefs is empty when every target is alive', () => {
    const db = setupTargets()
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 100, authorId: 10 } }) // users:10 alive
    expect(findBrokenRefs(db)).toEqual([])
  })
})

describe('findReferrersForMany — batched referrer counts for a selection', () => {
  beforeEach(() => clearRegistry())

  it('counts distinct external referrers per target, omitting targets nobody links to', () => {
    const db = setupTargets()
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 100, authorId: 10 } })
    maintainRecordRefs(db, { def: pagesC.def, before: null, after: { id: 101, authorId: 10 } })
    // users:10 is referenced by pages 100 + 101 (2 distinct); users:11 by nobody (omitted, not 0).
    expect(findReferrersForMany(db, 'users', [10, 11])).toEqual({ 10: 2 })
    expect(findReferrersForMany(db, 'users', [11])).toEqual({})
  })

  it('excludes a referrer that is itself in the deletion selection (deleting a linked pair → no false warning)', () => {
    const db = freshDb() // only record_refs; maintainRecordRefs writes edges without needing source tables
    const nodes = defineCollection({
      name: 'nodes', mode: 'multi', translatable: false,
      fields: { parent: { type: 'relation', relation: { collection: 'nodes' } } },
    })
    maintainRecordRefs(db, { def: nodes, before: null, after: { id: 1, parentId: 2 } }) // node 1 → node 2
    maintainRecordRefs(db, { def: nodes, before: null, after: { id: 3, parentId: 2 } }) // node 3 → node 2
    // Deleting {2,3}: node 3 is in the selection, so it is not counted as an external referrer of node 2.
    expect(findReferrersForMany(db, 'nodes', [2, 3])).toEqual({ 2: 1 }) // only node 1 remains
    // Deleting just {2}: both node 1 and node 3 are external referrers.
    expect(findReferrersForMany(db, 'nodes', [2])).toEqual({ 2: 2 })
  })

  it('returns {} for an empty selection', () => {
    expect(findReferrersForMany(freshDb(), 'pages', [])).toEqual({})
  })

  it('returns null (indeterminate, not "no referrers") for a not-yet-migrated index (bare DB)', () => {
    const bare = drizzle(new Database(':memory:')) // no record_refs table
    expect(findReferrersForMany(bare, 'pages', [1, 2, 3])).toBeNull()
  })
})

describe('findReferrers / findReferrersForMany / findBrokenRefs — indeterminate vs. genuinely empty', () => {
  it('a missing record_refs table is null (could not check), not [] (checked, no referrers)', () => {
    const bare = drizzle(new Database(':memory:'))
    expect(findReferrers(bare, 'pages', 1)).toBeNull()
    expect(findBrokenRefs(bare)).toBeNull()
  })
})
