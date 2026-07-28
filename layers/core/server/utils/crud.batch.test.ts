import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { create, list, getOne, remove, removeMany, setStatusMany } from './crud'
import { parseIdList } from './http'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from './defineCollection'
import { createTestDb } from '../../../../test/helpers/db'
import { registerWriteListener, clearWriteListeners, type WriteEvent } from './write-events'
import { desiredSchema } from '../schema/desired'
import { diffSchema } from '../schema/diff'
import { renderSqlite } from '../schema/render-sqlite'
import { MAX_BULK_IDS } from '../../app/utils/list-limits'

type Row = Record<string, unknown>

// A status-bearing pageLike collection whose columns match the migrated `pages` table (createTestDb) — the
// exact shape crud.collections.test.ts uses, so create()/list() round-trip through the real schema.
const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true,
  seo: true, blocks: { enabled: true }, status: true,
  fields: { title: { type: 'text', required: true } },
}))
// A collection with NO status column — publish/unpublish must reject it before touching the DB.
const noStatus = buildCollection(defineCollection({
  name: 'nostat', mode: 'multi', translatable: false, fields: { title: { type: 'text', required: true } },
}))
// A singleton — batch mutations must refuse it (405), mirroring the single-record routes.
const settings = buildCollection(defineCollection({
  name: 'settings', mode: 'single', translatable: true, fields: { siteName: { type: 'text' } },
}))

let db: ReturnType<typeof createTestDb>
let events: WriteEvent[]
beforeEach(() => {
  db = createTestDb()
  events = []
  clearWriteListeners()
  // Snapshot before/after so later mutations can't disturb what we assert about each emit.
  registerWriteListener((e) => events.push({
    def: e.def,
    before: e.before ? { ...e.before } : null,
    after: e.after ? { ...e.after } : null,
  }))
})
afterEach(() => clearWriteListeners())

describe('removeMany', () => {
  it('deletes exactly the given rows, leaves the rest, and emits (before,null) once per row AFTER the write', () => {
    const a = create(db, pages, { title: 'A' }) as Row
    const b = create(db, pages, { title: 'B' }) as Row
    const c = create(db, pages, { title: 'C' }) as Row
    events.length = 0

    const res = removeMany(db, pages, [a.id as number, b.id as number])
    expect(res.count).toBe(2)
    expect(res.ids.sort()).toEqual([a.id, b.id].sort())
    // Only c survives.
    expect(list(db, pages, { locale: 'all' }).data.map((r) => r.id)).toEqual([c.id])
    // Exactly two delete emits, each carrying the deleted row as `before` and null as `after`.
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.after).toBeNull()
      expect([a.id, b.id]).toContain(e.before!.id)
    }
  })

  it('is ALL-OR-NOTHING: an unknown id anywhere in the batch deletes nothing and emits nothing (404)', () => {
    const a = create(db, pages, { title: 'A' }) as Row
    const b = create(db, pages, { title: 'B' }) as Row
    events.length = 0

    expect(() => removeMany(db, pages, [a.id as number, 999_999, b.id as number]))
      .toThrowError(/not found.*999999|404/)
    expect(list(db, pages, { locale: 'all' }).total).toBe(2) // nothing deleted
    expect(events).toHaveLength(0) // nothing emitted (no stray publish-prune for an un-deleted row)
  })

  it('refuses a singleton collection (405)', () => {
    expect(() => removeMany(db, settings, [1])).toThrowError(/singleton|405/i)
  })

  it('single-record remove() is a thin delegate over removeMany([id]) with the unchanged {deleted,id} contract', () => {
    const a = create(db, pages, { title: 'Solo' }) as Row
    events.length = 0
    expect(remove(db, pages, a.id as number)).toEqual({ deleted: true, id: a.id })
    expect(() => getOne(db, pages, a.id as number)).toThrowError(/not found|404/)
    expect(events).toHaveLength(1)
    expect(events[0]!.before!.id).toBe(a.id)
    expect(events[0]!.after).toBeNull()
  })
})

describe('setStatusMany', () => {
  it('PUBLISH persists status, bumps updatedAt, and emits draft→published once per row (drives the publish queue)', () => {
    const a = create(db, pages, { title: 'A' }) as Row
    const b = create(db, pages, { title: 'B' }) as Row
    expect(a.status).toBe('draft')
    events.length = 0

    const res = setStatusMany(db, pages, [a.id as number, b.id as number], 'published')
    expect(res.count).toBe(2)
    for (const r of list(db, pages, { locale: 'all' }).data as Row[]) expect(r.status).toBe('published')

    expect(events).toHaveLength(2)
    for (const e of events) {
      // before.status='draft' + after.status='published' is exactly the transition classifyWrite (public
      // layer) reduces to a PUBLISH → render selfRoute; asserting the emitted pair keeps this test in-layer.
      expect(e.before!.status).toBe('draft')
      expect(e.after!.status).toBe('published')
      expect(e.after!.updatedAt).toBeInstanceOf(Date)
    }
  })

  it('UNPUBLISH sets draft and emits published→draft (an offline transition is never blockable)', () => {
    const a = create(db, pages, { title: 'A', status: 'published' }) as Row
    events.length = 0

    setStatusMany(db, pages, [a.id as number], 'draft')
    expect((getOne(db, pages, a.id as number) as Row).status).toBe('draft')
    expect(events).toHaveLength(1)
    expect(events[0]!.before!.status).toBe('published')
    expect(events[0]!.after!.status).toBe('draft')
  })

  it('rejects a collection without a status column (400), before any write', () => {
    expect(() => setStatusMany(db, noStatus, [1], 'published')).toThrowError(/has no status|400/)
  })

  it('refuses a singleton collection (405)', () => {
    expect(() => setStatusMany(db, settings, [1], 'published')).toThrowError(/singleton|405/i)
  })

  it('is ALL-OR-NOTHING: a missing id mutates nothing and emits nothing (404)', () => {
    const a = create(db, pages, { title: 'A' }) as Row
    events.length = 0

    expect(() => setStatusMany(db, pages, [a.id as number, 888_888], 'published')).toThrowError(/not found|404/)
    expect((getOne(db, pages, a.id as number) as Row).status).toBe('draft') // untouched
    expect(events).toHaveLength(0)
  })

  it('validates on PUBLISH only: a broken record blocks publish (400) but can ALWAYS be taken offline', () => {
    // A collection with a conditional-required field; build its table directly so we can seed a row that
    // is invalid-for-publish (format='image' but no caption) — create() would never let such a row exist.
    const gated = buildCollection(defineCollection({
      name: 'gated', mode: 'multi', translatable: false, status: true,
      fields: {
        format: { type: 'text', required: true },
        caption: { type: 'text', required: true, condition: { field: 'format', is: 'image' } },
      },
    }))
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([gated.table]), {}))) sqlite.exec(stmt)
    const gdb = drizzle(sqlite)
    // A published-but-broken row (e.g. a requirement was added after it went live).
    gdb.run(sql`INSERT INTO gated (format, caption, status, created_at, updated_at) VALUES ('image', NULL, 'published', 0, 0)`)
    const rowId = (gdb.select().from(gated.table).all()[0] as Row).id as number
    events.length = 0

    // Re-publishing runs assertConditions → the empty required caption is a clean 400; nothing mutated/emitted.
    expect(() => setStatusMany(gdb, gated, [rowId], 'published')).toThrowError(/Validation failed|400/)
    expect(events).toHaveLength(0)

    // Unpublishing the SAME broken row succeeds — validation runs on publish only.
    const res = setStatusMany(gdb, gated, [rowId], 'draft')
    expect(res.count).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]!.after!.status).toBe('draft')
  })
})

describe('parseIdList — the shared bulk/query id contract', () => {
  it('parses a number[] body and a comma query string, deduping and preserving first-seen order', () => {
    expect(parseIdList([3, 1, 2], MAX_BULK_IDS)).toEqual([3, 1, 2])
    expect(parseIdList('3,1,2', MAX_BULK_IDS)).toEqual([3, 1, 2])
    expect(parseIdList('1, 2 ,2, 3', MAX_BULK_IDS)).toEqual([1, 2, 3])
    expect(parseIdList([1, 2, 2, 3], MAX_BULK_IDS)).toEqual([1, 2, 3])
  })

  it('rejects an empty list, a non-positive-integer id, and an over-cap list (400)', () => {
    expect(() => parseIdList([], MAX_BULK_IDS)).toThrowError(/non-empty/)
    expect(() => parseIdList(undefined, MAX_BULK_IDS)).toThrowError(/non-empty/)
    expect(() => parseIdList([0], MAX_BULK_IDS)).toThrowError(/Invalid id/)
    expect(() => parseIdList([-2], MAX_BULK_IDS)).toThrowError(/Invalid id/)
    expect(() => parseIdList([1.5], MAX_BULK_IDS)).toThrowError(/Invalid id/)
    expect(() => parseIdList(['abc'], MAX_BULK_IDS)).toThrowError(/Invalid id/)
    expect(() => parseIdList(Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => i + 1), MAX_BULK_IDS))
      .toThrowError(/Too many ids/)
  })

  it('caps the RAW input, not the deduped result: cap+1 entries that dedupe to 2 still 400', () => {
    // Alternating 1s and 2s — all valid positive ints, deduping to just {1,2} which would fit under the
    // cap. The early bound must still reject on raw length so a million-id body cannot be fully walked.
    const overCap = Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => (i % 2) + 1)
    expect(new Set(overCap).size).toBe(2)
    expect(() => parseIdList(overCap, MAX_BULK_IDS)).toThrowError(/Too many ids/)
    expect(() => parseIdList(overCap.join(','), MAX_BULK_IDS)).toThrowError(/Too many ids/)
    // A raw list AT the cap is still accepted (boundary is inclusive), even before dedupe shrinks it.
    expect(parseIdList(Array.from({ length: MAX_BULK_IDS }, () => 1), MAX_BULK_IDS)).toEqual([1])
  })
})
