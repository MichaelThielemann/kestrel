import { describe, it, expect, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { create, list } from '../../../src/server/utils/crud.js'
import { buildCollection } from '../../../src/server/schema/buildCollection.js'
import { defineCollection } from '../../../src/index.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { outboxContent } from '../../../src/server/database/outbox-content.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { revisionsTable } from '../../../src/server/db/revisions.js'

// One collection spanning every FilterKind whose predicate differs: text/richtext (LIKE), number/datetime
// (comparisons), stringSet (choice-multi) + idSet (media-multi) via json_each membership.
const posts = buildCollection(defineCollection({
  name: 'posts', mode: 'multi', translatable: false,
  fields: {
    title: { type: 'text' },
    body: { type: 'richtext' },
    score: { type: 'number', options: { integer: true } },
    publishedAt: { type: 'datetime', options: { precision: 'date' } },
    reviewedAt: { type: 'datetime' }, // full-precision (TEXT 'YYYY-MM-DDTHH:MM:SS')
    tags: { type: 'choice', options: { multiple: true, choices: [{ label: 'News', value: 'news' }, { label: 'Blog', value: 'blog' }, { label: 'Tech', value: 'tech' }] } },
    gallery: { type: 'media', options: { multiple: true } },
  },
}))

function freshDb() {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, posts.table, revisionsTable('posts')]), {}))) sqlite.exec(stmt)
  return drizzle(sqlite)
}
let db: ReturnType<typeof freshDb>

beforeEach(() => {
  db = freshDb()
  create(db, posts, { title: 'Alpha', body: '<p>hello world</p>', score: 10, publishedAt: '2026-01-01', reviewedAt: '2026-07-25T09:00:00', tags: ['news', 'tech'], gallery: [1, 2] })
  create(db, posts, { title: 'Beta', body: '<p>goodbye</p>', score: 20, publishedAt: '2026-06-01', reviewedAt: '2026-07-25T16:00:00', tags: ['blog'], gallery: [2, 3] })
  create(db, posts, { title: 'Gamma', body: '<p>hello again</p>', score: 30, publishedAt: '2026-12-01', reviewedAt: '2026-07-26T08:00:00', tags: ['news'], gallery: [3] })
})

// Deterministic ordering by score (createdAt ties within the same ms).
const titles = (filter: Parameters<typeof list>[2]['filter']) => list(db, posts, { filter, sort: 'score' }).data.map((r) => r.title)

describe('filterCondition — comparisons (number + datetime)', () => {
  it('number eq/ne/lt/lte/gt/gte', () => {
    expect(titles([{ field: 'score', op: 'eq', value: '20' }])).toEqual(['Beta'])
    expect(titles([{ field: 'score', op: 'ne', value: '20' }])).toEqual(['Alpha', 'Gamma'])
    expect(titles([{ field: 'score', op: 'lt', value: '20' }])).toEqual(['Alpha'])
    expect(titles([{ field: 'score', op: 'lte', value: '20' }])).toEqual(['Alpha', 'Beta'])
    expect(titles([{ field: 'score', op: 'gt', value: '20' }])).toEqual(['Gamma'])
    expect(titles([{ field: 'score', op: 'gte', value: '20' }])).toEqual(['Beta', 'Gamma'])
  })

  it('ne on a nullable column includes NULL rows (SQL <> excludes them by three-valued logic)', () => {
    create(db, posts, { title: 'Delta' }) // score omitted -> NULL
    expect(titles([{ field: 'score', op: 'ne', value: '20' }]).sort()).toEqual(['Alpha', 'Delta', 'Gamma'])
  })

  it('datetime field compares lexicographically over the stored ISO date string', () => {
    expect(titles([{ field: 'publishedAt', op: 'lt', value: '2026-06-01' }])).toEqual(['Alpha'])
    expect(titles([{ field: 'publishedAt', op: 'gte', value: '2026-06-01' }])).toEqual(['Beta', 'Gamma'])
  })

  it('createdAt (ms-timestamp column) gte a past date returns all, gte a future date returns none', () => {
    expect(titles([{ field: 'createdAt', op: 'gte', value: '2000-01-01' }])).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(titles([{ field: 'createdAt', op: 'gte', value: '2999-01-01' }])).toEqual([])
  })
})

// A date-only value (`filter[c][lte]=2026-07-25`, what an <input type="date"> emits) names a whole DAY,
// not its midnight instant — the wire contract every client shares, admin or not.
describe('filterCondition — date-only bounds on a datetime column cover the whole day', () => {
  it('"on or before" a day includes that day\'s timestamps (TEXT datetime column)', () => {
    expect(titles([{ field: 'reviewedAt', op: 'lte', value: '2026-07-25' }])).toEqual(['Alpha', 'Beta'])
  })

  it('"after" a day excludes that day\'s timestamps', () => {
    expect(titles([{ field: 'reviewedAt', op: 'gt', value: '2026-07-25' }])).toEqual(['Gamma'])
  })

  it('crosses month/year boundaries', () => {
    create(db, posts, { title: 'Rollover', score: 40, publishedAt: '2026-12-31', reviewedAt: '2026-12-31T23:59:00', tags: [], gallery: [] })
    expect(titles([{ field: 'reviewedAt', op: 'lte', value: '2026-12-31' }])).toEqual(['Alpha', 'Beta', 'Gamma', 'Rollover'])
    expect(titles([{ field: 'reviewedAt', op: 'gt', value: '2026-12-31' }])).toEqual([])
  })

  it('"before" / "on or after" a day are unchanged (already exclusive/inclusive at the day start)', () => {
    expect(titles([{ field: 'reviewedAt', op: 'lt', value: '2026-07-25' }])).toEqual([])
    expect(titles([{ field: 'reviewedAt', op: 'gte', value: '2026-07-25' }])).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('a value carrying a time is compared as the exact instant, not widened to its day', () => {
    expect(titles([{ field: 'reviewedAt', op: 'lte', value: '2026-07-25T09:00:00' }])).toEqual(['Alpha'])
    expect(titles([{ field: 'reviewedAt', op: 'gt', value: '2026-07-25T09:00:00' }])).toEqual(['Beta', 'Gamma'])
  })

  it('applies to a ms-timestamp column too (createdAt "on or before today")', () => {
    // Derived from the stored rows, not the clock, so a run straddling UTC midnight can't make this flaky.
    const rows = list(db, posts, {}).data as Array<{ createdAt: Date }>
    const day = new Date(Math.max(...rows.map((r) => new Date(r.createdAt).getTime()))).toISOString().slice(0, 10)
    expect(titles([{ field: 'createdAt', op: 'lte', value: day }])).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(titles([{ field: 'createdAt', op: 'gt', value: day }])).toEqual([])
  })

  it('a date-shaped but impossible value stays a clean 400 on a timestamp column (no crash)', () => {
    expect(() => titles([{ field: 'createdAt', op: 'lte', value: '2026-13-01' }])).toThrowError(/Invalid timestamp filter value/)
  })

  it('never turns a non-existent calendar date into a different filter', () => {
    // '2026-02-31' rolls forward three days, so widening it to "its next day" would silently include
    // March 1-3 — the URL must never mean more than it says.
    create(db, posts, { title: 'March', score: 40, publishedAt: '2026-03-02', reviewedAt: '2026-03-02T10:00:00', tags: [], gallery: [] })
    expect(titles([{ field: 'reviewedAt', op: 'lte', value: '2026-02-31' }])).toEqual([])
  })
})

describe('filterCondition — LIKE (text / richtext)', () => {
  it('text contains is a case-insensitive substring match', () => {
    expect(titles([{ field: 'title', op: 'contains', value: 'lph' }])).toEqual(['Alpha'])
    expect(titles([{ field: 'title', op: 'contains', value: 'ALPHA' }])).toEqual(['Alpha']) // ASCII case-insensitive
  })

  it('richtext contains matches the stored HTML source (documented caveat)', () => {
    expect(titles([{ field: 'body', op: 'contains', value: 'hello' }])).toEqual(['Alpha', 'Gamma'])
    // searching for a tag character hits the HTML source, not just visible text
    expect(titles([{ field: 'body', op: 'contains', value: '<p' }])).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('escapes LIKE metacharacters so % and _ match literally', () => {
    create(db, posts, { title: 'ten%off_now', score: 40, publishedAt: '2026-02-02', tags: [], gallery: [] })
    expect(titles([{ field: 'title', op: 'contains', value: '%off' }])).toEqual(['ten%off_now']) // literal %, not wildcard
    expect(titles([{ field: 'title', op: 'contains', value: 'off_now' }])).toEqual(['ten%off_now']) // literal _
    // a plain '%' does not wildcard-match the metachar-free rows
    expect(titles([{ field: 'title', op: 'contains', value: '%' }])).toEqual(['ten%off_now'])
  })
})

describe('filterCondition — json_each membership (stringSet / idSet)', () => {
  it('stringSet (multi-choice) contains / notContains', () => {
    expect(titles([{ field: 'tags', op: 'contains', value: 'news' }])).toEqual(['Alpha', 'Gamma'])
    expect(titles([{ field: 'tags', op: 'notContains', value: 'news' }])).toEqual(['Beta'])
  })

  it('idSet (multi-media) contains / notContains match integer ids', () => {
    expect(titles([{ field: 'gallery', op: 'contains', value: '2' }])).toEqual(['Alpha', 'Beta'])
    expect(titles([{ field: 'gallery', op: 'notContains', value: '2' }])).toEqual(['Gamma'])
  })

  it('a non-numeric idSet value is a clean 400 (never a mismatch that silently matches nothing)', () => {
    expect(() => titles([{ field: 'gallery', op: 'contains', value: 'abc' }])).toThrowError(/Invalid id filter value/)
    // empty / whitespace are Number-finite (0) but not real ids — reject, don't silently match nothing.
    expect(() => titles([{ field: 'gallery', op: 'contains', value: '' }])).toThrowError(/Invalid id filter value/)
    expect(() => titles([{ field: 'gallery', op: 'contains', value: '   ' }])).toThrowError(/Invalid id filter value/)
    // non-integer numeric forms (exponent / decimal) are not id tokens either.
    expect(() => titles([{ field: 'gallery', op: 'contains', value: '1e3' }])).toThrowError(/Invalid id filter value/)
    expect(() => titles([{ field: 'gallery', op: 'contains', value: '1.5' }])).toThrowError(/Invalid id filter value/)
    // a plain integer still works (and surrounding whitespace is tolerated).
    expect(titles([{ field: 'gallery', op: 'contains', value: '7' }])).toEqual([]) // no row references id 7
    expect(titles([{ field: 'gallery', op: 'contains', value: ' 3 ' }])).toEqual(['Beta', 'Gamma'])
  })
})

describe('filterCondition — validation (never a 500)', () => {
  it('an operator not allowed for the field kind is a clean 400', () => {
    expect(() => list(db, posts, { filter: [{ field: 'title', op: 'lt', value: 'x' }] })).toThrowError(/not allowed/)
    expect(() => list(db, posts, { filter: [{ field: 'score', op: 'contains', value: '1' }] })).toThrowError(/not allowed/)
    expect(() => list(db, posts, { filter: [{ field: 'tags', op: 'eq', value: 'news' }] })).toThrowError(/not allowed/)
  })

  it('an unknown / non-filterable field is a clean 400', () => {
    expect(() => list(db, posts, { filter: [{ field: 'nope', op: 'eq', value: 'x' }] })).toThrowError(/Unknown filter field/)
    expect(() => list(db, posts, { filter: [{ field: 'toString', op: 'eq', value: 'x' }] })).toThrowError(/Unknown filter field/)
  })
})

describe('filterCondition — injection safety (every value is a bound param)', () => {
  const tableExists = () => (db.get(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='posts'`) as { name?: string } | undefined)?.name === 'posts'

  it('a SQL-injection payload in a LIKE value returns a normal (empty) set and leaves the table intact', () => {
    expect(titles([{ field: 'title', op: 'contains', value: "x'); DROP TABLE posts;--" }])).toEqual([])
    expect(tableExists()).toBe(true)
    expect(titles([])).toEqual(['Alpha', 'Beta', 'Gamma']) // all rows still there
  })

  it('a SQL-injection payload in an eq value is treated as a literal, not executed', () => {
    expect(titles([{ field: 'title', op: 'eq', value: "'; DROP TABLE posts;--" }])).toEqual([])
    expect(tableExists()).toBe(true)
  })

  it('a metachar/quote payload in a json_each membership value is bound, not interpolated', () => {
    expect(titles([{ field: 'tags', op: 'contains', value: "a%_')--" }])).toEqual([])
    expect(tableExists()).toBe(true)
  })
})
