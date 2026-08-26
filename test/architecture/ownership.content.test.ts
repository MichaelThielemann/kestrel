import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { Effect } from 'effect'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { OwnershipManifest } from '@michaelthielemann/kestrel-contracts'
import { createTestDb } from '../helpers/db'
import { buildCollection, OwnershipViolation, buildContentManifest, clearRegistry, create, defineCollection, desiredSchema, diffSchema, findBrokenRefs, findReferrers, maintainRecordRefs, makeModuleDb, rebuildRecordRefs, recordRefs, registerCollection, renderSqlite, useContentDbFor  } from '@michaelthielemann/kestrel-core'
import { richtextLinkHref } from '@michaelthielemann/kestrel-core/client'
import { pagesCollection } from '@michaelthielemann/kestrel-collections'
import postsCollection from '../../server/collections/posts'
import { folders } from '@michaelthielemann/kestrel-media'

function seed() {
  clearRegistry()
  registerCollection(pagesCollection)
  registerCollection(postsCollection)
  return createTestDb()
}

describe('content module — ownership enforcement (ADR-0012)', () => {
  it('the manifest owns record_refs plus every currently registered collection table', () => {
    seed()
    const manifest = buildContentManifest()
    expect(manifest.module).toBe('content')
    expect(manifest.tables).toEqual(expect.arrayContaining(['record_refs', 'pages', 'posts']))
    expect(manifest.tables).not.toContain('folders')
  })

  it('the adapter cache invalidates when the registered collection set changes, not just when the db client does', () => {
    const db = seed() // pages + posts
    const before = useContentDbFor(db)
    expect(before.tables.posts).toBeDefined()

    clearRegistry()
    registerCollection(pagesCollection) // posts deregistered — same db, same client

    const after = useContentDbFor(db)
    expect(after.tables.posts).toBeUndefined()
    expect(after.tables.pages).toBeDefined()
  })

  it('own-table access (record_refs and a collection table) succeeds through the adapter', () => {
    const db = seed()
    const svc = useContentDbFor(db)
    expect(() => svc.db.insert(svc.tables.record_refs as typeof recordRefs).values({
      sourceColl: 'pages', sourceId: 1, targetColl: 'posts', targetId: 2,
    }).run()).not.toThrow()
    expect(() => svc.db.select().from(svc.tables.record_refs as typeof recordRefs).all()).not.toThrow()
    expect(() => svc.db.select().from(svc.tables.pages as typeof pagesCollection.table).all()).not.toThrow()
  })

  it('a cross-module raw-SQL access to a foreign table (media\'s folders) throws OwnershipViolation', () => {
    const db = seed()
    const svc = useContentDbFor(db)
    expect(() => svc.db.prepare('SELECT * FROM folders').all()).toThrow(OwnershipViolation)
    try {
      svc.db.prepare('SELECT * FROM folders').all()
      expect.fail('expected OwnershipViolation')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnershipViolation)
      const violation = err as OwnershipViolation
      expect(violation.table).toBe('folders')
      expect(violation.module).toBe('content')
    }
  })

  it('a Drizzle query joining an own table against a foreign one throws OwnershipViolation', () => {
    const db = seed()
    const svc = useContentDbFor(db)
    expect(() => {
      svc.db.select().from(svc.tables.record_refs as typeof recordRefs)
        .leftJoin(folders, eq(recordRefs.sourceId, folders.id))
        .all()
    }).toThrow(OwnershipViolation)
  })

  it('real content utils (maintainRecordRefs, findReferrers) work unchanged against the adapter-scoped db', () => {
    const db = seed()
    const svc = useContentDbFor(db)
    const target = { id: 42 }
    const body = `<p><a href="${richtextLinkHref('pages', target.id)}">see the page</a></p>`
    maintainRecordRefs(svc.db, { def: pagesCollection.def, before: null, after: target })
    maintainRecordRefs(svc.db, { def: postsCollection.def, before: null, after: { id: 7, body } })
    expect(findReferrers(svc.db, 'pages', target.id)).toEqual([{ collection: 'posts', id: 7 }])
  })

  it('rebuildRecordRefs (the production rebuild entry point) reconstructs the index through the adapter after it is wiped', () => {
    const db = seed()
    const target = create(db, pagesCollection, { title: 'Target', path: '/target', status: 'published' }) as Record<string, unknown>
    const targetId = target.id as number
    const body = `<p><a href="${richtextLinkHref('pages', targetId)}">see the page</a></p>`
    const referrer = create(db, postsCollection, { title: 'Referrer', body, status: 'published' }) as Record<string, unknown>
    const refId = referrer.id as number
    maintainRecordRefs(db, { def: postsCollection.def, before: null, after: referrer })

    const svc = useContentDbFor(db)
    const before = svc.db.select().from(svc.tables.record_refs as typeof recordRefs).all()
    expect(before.length).toBeGreaterThan(0)

    svc.db.delete(svc.tables.record_refs as typeof recordRefs).run()
    expect(findReferrers(svc.db, 'pages', targetId)).toEqual([])

    rebuildRecordRefs(svc.db)
    expect(findReferrers(svc.db, 'pages', targetId)).toEqual([{ collection: 'posts', id: refId }])
  })

  it('rebuildRecordRefs is transactional: a failure mid-replay leaves the ORIGINAL index intact, not purged', () => {
    const db = seed()
    const target = create(db, pagesCollection, { title: 'Target', path: '/target', status: 'published' }) as Record<string, unknown>
    const targetId = target.id as number
    const body = `<p><a href="${richtextLinkHref('pages', targetId)}">see the page</a></p>`
    const referrer = create(db, postsCollection, { title: 'Referrer', body, status: 'published' }) as Record<string, unknown>
    const refId = referrer.id as number
    maintainRecordRefs(db, { def: postsCollection.def, before: null, after: referrer })

    // `ghost` is registered (so `allCollections()` — and therefore the rebuild loop — reaches it) but its
    // table was never migrated in this db: the replay's `select` on it throws a real (non-Ownership) error
    // partway through, exactly the "some iteration throws" scenario the transaction has to survive.
    const ghost = buildCollection(defineCollection({
      name: 'ghost', mode: 'multi', translatable: false, fields: { title: { type: 'text' } },
    }))
    registerCollection(ghost)

    const svc = useContentDbFor(db)
    const before = svc.db.select().from(svc.tables.record_refs as typeof recordRefs).all()
    expect(before.length).toBeGreaterThan(0)

    expect(() => rebuildRecordRefs(svc.db)).toThrow()

    // Rollback observed: the index is exactly what it was before the failed rebuild attempt — neither
    // purged-and-partial nor silently half-replayed.
    const after = svc.db.select().from(svc.tables.record_refs as typeof recordRefs).all()
    expect(after).toEqual(before)
    expect(findReferrers(svc.db, 'pages', targetId)).toEqual([{ collection: 'posts', id: refId }])
  })

  it('a stale-manifest ownership violation reaches the caller through findBrokenRefs, not swallowed as "not migrated"', () => {
    // `leak` is registered globally (so `getCollection` resolves it inside `deadTargets`) but deliberately
    // left OUT of the adapter's manifest — simulating a content adapter cached before `leak` was
    // registered.
    clearRegistry()
    const leak = buildCollection(defineCollection({
      name: 'leak', mode: 'multi', translatable: false, fields: { title: { type: 'text' } },
    }))
    registerCollection(pagesCollection)
    registerCollection(leak)

    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([recordRefs, pagesCollection.table]), {}))) sqlite.exec(stmt)
    const manifest: OwnershipManifest = { module: 'content', tables: ['record_refs', 'pages'] } // omits 'leak'
    const tables: Record<string, AnySQLiteTable> = { record_refs: recordRefs, pages: pagesCollection.table as AnySQLiteTable }
    const { layer, tag } = makeModuleDb(manifest, sqlite, tables)
    const svc = Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))

    svc.db.insert(svc.tables.record_refs as typeof recordRefs).values({
      sourceColl: 'pages', sourceId: 1, targetColl: 'leak', targetId: 99,
    }).run()

    expect(() => findBrokenRefs(svc.db)).toThrow(OwnershipViolation)
  })
})
