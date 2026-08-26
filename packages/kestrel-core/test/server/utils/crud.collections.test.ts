import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { NotFound } from '@michaelthielemann/kestrel-contracts'
import { sql } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { create, list, getOne, update, remove, parseFilter, putSingleton, isUniqueViolation } from '../../../src/server/utils/crud.js'
import { resolveTranslations } from '../../../src/server/utils/translations.js'
import { clearPopulator, defineCollection, registerPopulator, withReadCapture } from '../../../src/index.js'
import { buildCollection } from '../../../src/server/schema/buildCollection.js'
import { registerBlock, clearBlocks } from '../../../src/server/blocks/registry.js'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { clearRegistry, registerCollection } from '../../../src/server/utils/registry.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { outboxContent } from '../../../src/server/database/outbox-content.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { ensureRevisionsTable, revisionsTable } from '../../../src/server/db/revisions.js'
import { sqliteClientOf } from '../../../src/server/db/outbox.js'

const pagesCollection = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true,
  seo: true, blocks: { enabled: true }, fields: { title: { type: 'text', required: true } },
}))

let db: ReturnType<typeof createTestDb>
beforeEach(() => {
  clearBlocks()
  registerBlock({ name: 'hero', fields: {} })
  db = createTestDb()
  ensureRevisionsTable(sqliteClientOf(db), 'pages')
  ensureRevisionsTable(sqliteClientOf(db), 'media')
})

describe('crud — collections', () => {
  it('creates with server-generated translationGroup and default primary locale', () => {
    const row = create(db, pagesCollection, { title: 'Home', path: '/Home' }) as Record<string, unknown>
    expect(row.id).toBeTypeOf('number')
    expect(row.locale).toBe('en')
    expect(typeof row.translationGroup).toBe('string')
    expect(row.path).toBe('/home') // lowercased
  })

  it('lists with locale filter and pagination shape', () => {
    create(db, pagesCollection, { title: 'A' })
    create(db, pagesCollection, { title: 'B', locale: 'de' })
    const en = list(db, pagesCollection, {})
    expect(en.total).toBe(1)
    expect(en).toMatchObject({ page: 1, perPage: 25 })
    const all = list(db, pagesCollection, { locale: 'all' })
    expect(all.total).toBe(2)
  })

  it('clamps a NaN/garbage page or perPage to the defaults (no unbounded LIMIT)', () => {
    // `?perPage=abc` → Number('abc') === NaN; the cap must NOT be bypassed (NaN limit = "no limit").
    for (let i = 0; i < 3; i++) create(db, pagesCollection, { title: `p${i}` })
    const res = list(db, pagesCollection, { page: Number('abc'), perPage: Number('abc') })
    expect(res.page).toBe(1)
    expect(res.perPage).toBe(25) // falls back to the default cap, not NaN
    // A perPage above the cap is still clamped to MAX_PER_PAGE (the shared list-limits ceiling).
    expect(list(db, pagesCollection, { perPage: 9999 }).perPage).toBe(500)
  })

  it('attaches a translation: same group, different locale, independent content', () => {
    const en = create(db, pagesCollection, { title: 'Home', content: [{ id: 'x', type: 'hero', props: {} }] }) as Record<string, unknown>
    const de = create(db, pagesCollection, { title: 'Start', locale: 'de', translationGroup: en.translationGroup as string, content: [] }) as Record<string, unknown>
    expect(de.translationGroup).toBe(en.translationGroup)
    const map = resolveTranslations(db, pagesCollection, en.id as number)
    expect(map).toEqual({ en: en.id, de: de.id })
  })

  it('rejects a duplicate locale within one translation group (409)', () => {
    const en = create(db, pagesCollection, { title: 'Home' }) as Record<string, unknown>
    expect(() => create(db, pagesCollection, { title: 'Home2', translationGroup: en.translationGroup as string }))
      .toThrowError(expect.objectContaining({ _tag: 'Conflict', field: 'locale' }))
  })

  it('rejects an invalid body (validation) and unknown sort field', () => {
    expect(() => create(db, pagesCollection, {})).toThrowError()
    expect(() => list(db, pagesCollection, { sort: 'nope' })).toThrowError(/Unknown sort/)
  })

  it('updates and deletes one variant', () => {
    const en = create(db, pagesCollection, { title: 'Home' }) as Record<string, unknown>
    const upd = update(db, pagesCollection, en.id as number, { title: 'Renamed' }) as Record<string, unknown>
    expect(upd.title).toBe('Renamed')
    expect(remove(db, pagesCollection, en.id as number)).toEqual({ deleted: true, id: en.id })
    expect(() => getOne(db, pagesCollection, en.id as number)).toThrowError(expect.objectContaining({ _tag: 'NotFound' }) as NotFound)
  })

  it('stores updatedAt at millisecond precision (concurrency token distinguishes same-second saves)', () => {
    const r = create(db, pagesCollection, { title: 'Ms' }) as Record<string, unknown>
    // a real ms-precision timestamp keeps its sub-second part (second-granularity would floor to xxx000)
    const ms = (r.updatedAt as Date).getTime()
    expect(Number.isInteger(ms)).toBe(true)
    // two updates in quick succession get DIFFERENT tokens as long as ≥1ms apart (buildTable uses timestamp_ms)
    const first = update(db, pagesCollection, r.id as number, { title: 'A' }) as Record<string, unknown>
    const t1 = (first.updatedAt as Date).getTime()
    expect(t1).toBeGreaterThanOrEqual(ms)
  })

  it('optimistic concurrency: a stale expectedUpdatedAt is rejected with 409, a matching one saves', () => {
    const en = create(db, pagesCollection, { title: 'Home' }) as Record<string, unknown>
    const stored = new Date(en.updatedAt as string | Date).getTime()

    // A stale baseline (the record moved on since this tab loaded it) is refused BEFORE any mutation —
    // the stale save can't revert the newer state (and propagate that revert into the static output).
    expect(() => update(db, pagesCollection, en.id as number, { title: 'B' }, { expectedUpdatedAt: stored - 5000 }))
      .toThrowError(expect.objectContaining({ _tag: 'Conflict' }))
    expect((getOne(db, pagesCollection, en.id as number) as Record<string, unknown>).title).toBe('Home')

    // The matching baseline (what the editor actually loaded) saves.
    expect((update(db, pagesCollection, en.id as number, { title: 'A' }, { expectedUpdatedAt: stored }) as Record<string, unknown>).title).toBe('A')

    // No precondition → unconditional save (backwards compatible for API clients that don't opt in).
    expect((update(db, pagesCollection, en.id as number, { title: 'C' }) as Record<string, unknown>).title).toBe('C')

    // A missing row still 404s (not 409) even with a precondition.
    expect(() => update(db, pagesCollection, 999999, { title: 'Z' }, { expectedUpdatedAt: stored }))
      .toThrowError(expect.objectContaining({ _tag: 'NotFound', id: 999999 }) as NotFound)
  })

  it('pageLike create auto-generates the slug from the title when no path is given', () => {
    const row = create(db, pagesCollection, { title: 'Über uns' }) as Record<string, unknown>
    expect(row.path).toBe('/uber-uns')
  })

  it('pageLike update normalizes an explicit slug, and leaves the slug alone when path is omitted', () => {
    const r = create(db, pagesCollection, { title: 'X', path: '/x' }) as Record<string, unknown>
    expect((update(db, pagesCollection, r.id as number, { path: '/Y' }) as Record<string, unknown>).path).toBe('/y')
    expect((update(db, pagesCollection, r.id as number, { title: 'X2' }) as Record<string, unknown>).path).toBe('/y')
  })

  it('parseFilter extracts filter[...] keys as eq clauses; a [op] suffix sets the operator', () => {
    expect(parseFilter({ 'filter[status]': 'published', sort: '-createdAt' }))
      .toEqual([{ field: 'status', op: 'eq', value: 'published' }])
    expect(parseFilter({ 'filter[createdAt][gte]': '2026-01-01' }))
      .toEqual([{ field: 'createdAt', op: 'gte', value: '2026-01-01' }])
  })

  it('parseFilter rejects an unknown operator token with a clean 400', () => {
    expect(() => parseFilter({ 'filter[title][bogus]': 'x' })).toThrowError(/Unknown filter operator/)
  })

  it('parseFilter emits one clause per repeated same-op value (multi-contains AND)', () => {
    expect(parseFilter({ 'filter[tags][contains]': ['a', 'b'] }))
      .toEqual([{ field: 'tags', op: 'contains', value: 'a' }, { field: 'tags', op: 'contains', value: 'b' }])
  })

  it('captures publish deps: list -> collection tag, getOne -> record tag; no-op outside a capture run', async () => {
    const a = create(db, pagesCollection, { title: 'A' }) as Record<string, unknown>
    const { tags } = await withReadCapture(async () => {
      list(db, pagesCollection, {})
      getOne(db, pagesCollection, a.id as number)
    })
    expect(tags).toContain('pages')
    expect(tags).toContain(`pages:${a.id}`)
    // capture:false suppresses the collection tag (the resolvePage self-lookup path)
    const { tags: suppressed } = await withReadCapture(async () => { list(db, pagesCollection, { capture: false }) })
    expect(suppressed).not.toContain('pages')
  })

  it('maps a UNIQUE violation on update (locale collision) to 409', () => {
    const en = create(db, pagesCollection, { title: 'Home' }) as Record<string, unknown>
    const de = create(db, pagesCollection, { title: 'Start', locale: 'de', translationGroup: en.translationGroup as string }) as Record<string, unknown>
    expect(() => update(db, pagesCollection, de.id as number, { locale: 'en' }))
      .toThrowError(expect.objectContaining({ _tag: 'Conflict', field: 'locale', value: 'en' }))
  })

  it('ignores client-supplied id/createdAt/updatedAt on create', () => {
    const a = create(db, pagesCollection, { title: 'A', id: 999 } as never) as Record<string, unknown>
    const b = create(db, pagesCollection, { title: 'B', id: 999 } as never) as Record<string, unknown>
    expect(a.id).not.toBe(b.id)
    expect(typeof a.id).toBe('number')
  })

  it('coerces array-valued locale/sort query params instead of throwing', () => {
    create(db, pagesCollection, { title: 'A' })
    create(db, pagesCollection, { title: 'B', locale: 'de' })
    const r = list(db, pagesCollection, { locale: ['de', 'en'] as never, sort: ['title', '-title'] as never })
    expect(r.total).toBe(1)
    expect((r.data[0] as Record<string, unknown>).title).toBe('B')
  })

  it('does not let update re-parent a row across translation groups', () => {
    const a = create(db, pagesCollection, { title: 'A' }) as Record<string, unknown>            // en, group A
    const b = create(db, pagesCollection, { title: 'B', locale: 'de' }) as Record<string, unknown> // de, group B
    const updated = update(db, pagesCollection, a.id as number, { translationGroup: b.translationGroup } as never) as Record<string, unknown>
    expect(updated.translationGroup).toBe(a.translationGroup)
  })

  it('rejects prototype-chain keys in filter and sort with a clean 400 (no 500)', () => {
    expect(() => list(db, pagesCollection, { filter: [{ field: 'toString', op: 'eq', value: 'x' }] }))
      .toThrowError(/Unknown filter field/)
    expect(() => list(db, pagesCollection, { sort: '__proto__' }))
      .toThrowError(/Unknown sort field/)
  })

  it('getOne/list apply the registered populator only at depth > 0', () => {
    registerPopulator((row, ctx) => ({ ...row, _p: ctx.depth }))
    try {
      const a = create(db, pagesCollection, { title: 'Home' }) as Record<string, unknown>
      expect((getOne(db, pagesCollection, a.id as number, 0) as Record<string, unknown>)._p).toBeUndefined()
      expect((getOne(db, pagesCollection, a.id as number, 2) as Record<string, unknown>)._p).toBe(2)
    } finally {
      clearPopulator()
    }
  })

  it('clamps an attacker-supplied depth to a bounded maximum (no unbounded relation recursion / DoS)', () => {
    registerPopulator((row, ctx) => ({ ...row, _p: ctx.depth }))
    try {
      const a = create(db, pagesCollection, { title: 'Home' }) as Record<string, unknown>
      expect((getOne(db, pagesCollection, a.id as number, 1_000_000) as Record<string, unknown>)._p).toBe(10)
      expect((list(db, pagesCollection, { depth: 1_000_000 }).data[0] as Record<string, unknown>)._p).toBe(10)
    } finally {
      clearPopulator()
    }
  })

  it('update normalizes an empty-string locale to the primary (never persists a bogus "" locale)', () => {
    const row = create(db, pagesCollection, { title: 'X', locale: 'de' }) as Record<string, unknown>
    const updated = update(db, pagesCollection, row.id as number, { locale: '' }) as Record<string, unknown>
    expect(updated.locale).toBe('en') // primary — matches create()'s coercion, not a stored ''
  })

  it('non-translatable collection: no locale handling, translations disabled', () => {
    const media = buildCollection(defineCollection({
      name: 'media', mode: 'multi', translatable: false,
      fields: {
        storageKey: { type: 'text', required: true, unique: true },
        folder: { type: 'text' },
        filename: { type: 'text', required: true },
        mime: { type: 'text', required: true },
        ext: { type: 'text', required: true },
        size: { type: 'number', required: true },
        width: { type: 'number' },
        height: { type: 'number' },
        checksum: { type: 'text' },
        thumbhash: { type: 'text' },
        derivatives: { type: 'json' },
        translations: { type: 'json' },
      },
    }))
    db.run(sql`CREATE TABLE IF NOT EXISTS media (
      id integer PRIMARY KEY AUTOINCREMENT,
      storage_key text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`)
    const a = create(db, media, { storageKey: 'a/x.jpg', filename: 'x.jpg', mime: 'image/jpeg', ext: 'jpg', size: 1 }) as Record<string, unknown>
    expect(a.id).toBeTypeOf('number')
    expect(a.locale).toBeUndefined()
    expect(a.translationGroup).toBeUndefined()
    create(db, media, { storageKey: 'b/y.jpg', filename: 'y.jpg', mime: 'image/jpeg', ext: 'jpg', size: 1 })
    expect(list(db, media, { locale: 'de' }).total).toBe(2)
    expect(() => resolveTranslations(db, media, a.id as number)).toThrowError(/Translations are not enabled/)
  })
})

describe('isUniqueViolation', () => {
  it('detects a SQLite UNIQUE-constraint error message, ignores others/non-errors', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: media.storage_key'))).toBe(true)
    expect(isUniqueViolation(new Error('no such table'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })
})

describe('crud — write-transforms recurse into repeater entries + block props (L7)', () => {
  it('derives a nested slug from its sibling (inside a repeater and inside block props)', () => {
    registerBlock({ name: 'card', fields: { title: { type: 'text' }, slug: { type: 'slug', options: { from: 'title' } } } })
    const c = buildCollection(defineCollection({
      name: 'docs', mode: 'multi', translatable: false, blocks: { enabled: true },
      fields: { links: { type: 'repeater', options: { fields: { label: { type: 'text' }, code: { type: 'slug', options: { from: 'label' } } } } } },
    }))
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, c.table, revisionsTable('docs')]), {}))) sqlite.exec(stmt)
    const idb = drizzle(sqlite)
    const row = create(idb, c, {
      links: [{ label: 'My First Item', code: '' }],
      content: [{ id: 'a', type: 'card', props: { title: 'Hello World', slug: '' } }],
    }) as Record<string, unknown>
    expect((row.links as { code: string }[])[0]!.code).toBe('my-first-item') // repeater sub-field transformed
    expect((row.content as { props: { slug: string } }[])[0]!.props.slug).toBe('hello-world') // block prop transformed
  })
})

describe('crud — multi-field default applies on create when omitted (L6)', () => {
  const items = buildCollection(defineCollection({
    name: 'items', mode: 'multi', translatable: false,
    fields: {
      title: { type: 'text' },
      tags: { type: 'choice', default: ['news'], options: { multiple: true, choices: [{ label: 'News', value: 'news' }, { label: 'Blog', value: 'blog' }] } },
      cfg: { type: 'json', default: { theme: 'dark' } },
    },
  }))
  it('an API create that omits a multi-choice / json field gets its declared default from the column', () => {
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, items.table, revisionsTable('items')]), {}))) sqlite.exec(stmt)
    const idb = drizzle(sqlite)
    const row = create(idb, items, { title: 'x' }) as Record<string, unknown>
    expect(row.tags).toEqual(['news'])
    expect(row.cfg).toEqual({ theme: 'dark' })
    // an explicit value still wins
    const row2 = create(idb, items, { title: 'y', tags: ['blog'] }) as Record<string, unknown>
    expect(row2.tags).toEqual(['blog'])
  })
})

describe('crud — list() filter type coercion', () => {
  const flags = buildCollection(defineCollection({
    name: 'flags', mode: 'multi', translatable: false,
    fields: { featured: { type: 'boolean' }, title: { type: 'text' } },
  }))
  let fdb: ReturnType<typeof createTestDb>
  beforeEach(() => {
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, flags.table, revisionsTable('flags')]), {}))) sqlite.exec(stmt)
    fdb = drizzle(sqlite)
  })

  it('coerces a boolean filter value so it matches, instead of silently returning nothing', () => {
    create(fdb, flags, { title: 'a', featured: true })
    create(fdb, flags, { title: 'b', featured: false })
    // parseFilter stringifies query params, so the value arrives as 'true' / 'false'.
    expect(list(fdb, flags, { filter: [{ field: 'featured', op: 'eq', value: 'true' }] }).data.map((r) => r.title)).toEqual(['a'])
    expect(list(fdb, flags, { filter: [{ field: 'featured', op: 'eq', value: 'false' }] }).data.map((r) => r.title)).toEqual(['b'])
  })
})

describe('crud — operator-aware filters (end-to-end through list)', () => {
  const posts = buildCollection(defineCollection({
    name: 'posts', mode: 'multi', translatable: false,
    fields: {
      title: { type: 'text' },
      score: { type: 'number', options: { integer: true } },
      publishedAt: { type: 'datetime', options: { precision: 'date' } },
      tags: { type: 'choice', options: { multiple: true, choices: [{ label: 'News', value: 'news' }, { label: 'Blog', value: 'blog' }, { label: 'Tech', value: 'tech' }] } },
    },
  }))
  let pdb: ReturnType<typeof createTestDb>
  beforeEach(() => {
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, posts.table, revisionsTable('posts')]), {}))) sqlite.exec(stmt)
    pdb = drizzle(sqlite)
    create(pdb, posts, { title: 'Alpha', score: 10, publishedAt: '2026-01-01', tags: ['news', 'tech'] })
    create(pdb, posts, { title: 'Beta', score: 20, publishedAt: '2026-06-01', tags: ['blog'] })
    create(pdb, posts, { title: 'Gamma', score: 30, publishedAt: '2026-12-01', tags: ['news'] })
  })
  const titles = (filter: Parameters<typeof list>[2]['filter']) => list(pdb, posts, { filter, sort: 'score' }).data.map((r) => r.title)

  it('number gt / lte and datetime-field lt / gte compare correctly', () => {
    expect(titles([{ field: 'score', op: 'gt', value: '15' }])).toEqual(['Beta', 'Gamma'])
    expect(titles([{ field: 'score', op: 'lte', value: '20' }])).toEqual(['Alpha', 'Beta'])
    expect(titles([{ field: 'publishedAt', op: 'lt', value: '2026-06-01' }])).toEqual(['Alpha'])
    expect(titles([{ field: 'publishedAt', op: 'gte', value: '2026-06-01' }])).toEqual(['Beta', 'Gamma'])
  })

  it('text contains is a substring match', () => {
    expect(titles([{ field: 'title', op: 'contains', value: 'et' }])).toEqual(['Beta'])
  })

  it('multi-choice contains / notContains use json_each membership; repeated contains AND-s', () => {
    expect(titles([{ field: 'tags', op: 'contains', value: 'news' }])).toEqual(['Alpha', 'Gamma'])
    expect(titles([{ field: 'tags', op: 'notContains', value: 'news' }])).toEqual(['Beta'])
    // two contains clauses on the same array field AND together → only the row with BOTH tags
    expect(titles([{ field: 'tags', op: 'contains', value: 'news' }, { field: 'tags', op: 'contains', value: 'tech' }])).toEqual(['Alpha'])
  })

  it('rejects an operator not allowed for the field kind with a clean 400 (never a 500)', () => {
    expect(() => list(pdb, posts, { filter: [{ field: 'title', op: 'lt', value: 'x' }] })).toThrowError(/not allowed/)
    expect(() => list(pdb, posts, { filter: [{ field: 'score', op: 'contains', value: '1' }] })).toThrowError(/not allowed/)
    // a multi-choice (stringSet) column allows only contains/notContains — eq is a clean 400
    expect(() => list(pdb, posts, { filter: [{ field: 'tags', op: 'eq', value: 'news' }] })).toThrowError(/not allowed/)
  })
})

describe('crud — pageLike global slug uniqueness (registry-backed)', () => {
  const pagesC = buildCollection(defineCollection({ name: 'pages', mode: 'multi', translatable: true, pageLike: true, fields: { title: { type: 'text', required: true } } }))
  const postsC = buildCollection(defineCollection({ name: 'posts', mode: 'multi', translatable: true, pageLike: true, fields: { title: { type: 'text', required: true } } }))
  let rdb: ReturnType<typeof createTestDb>

  beforeEach(() => {
    clearRegistry()
    registerCollection(pagesC)
    registerCollection(postsC)
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, pagesC.table, postsC.table, revisionsTable('pages'), revisionsTable('posts')]), {}))) sqlite.exec(stmt)
    rdb = drizzle(sqlite)
  })
  afterEach(() => clearRegistry())

  it('rejects an explicit slug that collides across collections (409)', () => {
    create(rdb, pagesC, { title: 'X', path: '/x' })
    expect(() => create(rdb, postsC, { title: 'Y', path: '/x' })).toThrowError(expect.objectContaining({ _tag: 'Conflict' }))
  })

  it('de-duplicates an auto-generated slug across collections (-2)', () => {
    create(rdb, pagesC, { title: 'About' }) // → /about
    expect((create(rdb, postsC, { title: 'About' }) as Record<string, unknown>).path).toBe('/about-2')
  })

  it('rejects a locale-only PATCH that re-routes a row into a cross-collection collision (409)', () => {
    const a = create(rdb, pagesC, { title: 'X', path: '/x' }) as Record<string, unknown>  // en → /x
    create(rdb, postsC, { title: 'Y', path: '/x', locale: 'de' })                         // de → /de/x
    // moving the page to de re-routes it to /de/x, which the de post already owns
    expect(() => update(rdb, pagesC, a.id as number, { locale: 'de' })).toThrowError(expect.objectContaining({ _tag: 'Conflict' }))
  })

  it('rejects a pageLike create with neither an explicit path nor a title to derive one from (400)', () => {
    const noTitle = buildCollection(defineCollection({ name: 'notes', mode: 'multi', translatable: false, pageLike: true, fields: { body: { type: 'text' } } }))
    clearRegistry()
    registerCollection(pagesC)
    registerCollection(noTitle)
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, pagesC.table, noTitle.table, revisionsTable('pages'), revisionsTable('notes')]), {}))) sqlite.exec(stmt)
    const db2 = drizzle(sqlite)
    expect(() => create(db2, noTitle, {})).toThrowError(/slug is required|Validation/)
  })

  it('de-duplicates an auto-generated slug within the SAME collection, continuing past -2 to -3', () => {
    create(rdb, pagesC, { title: 'About' })                                  // → /about
    create(rdb, pagesC, { title: 'About' })                                  // → /about-2
    expect((create(rdb, pagesC, { title: 'About' }) as Record<string, unknown>).path).toBe('/about-3')
  })

  it('on update with a blank path, re-derives the slug from the (unchanged) title', () => {
    const a = create(rdb, pagesC, { title: 'Contact Us' }) as Record<string, unknown> // → /contact-us
    expect((update(rdb, pagesC, a.id as number, { path: '' }) as Record<string, unknown>).path).toBe('/contact-us')
  })
})

describe('crud — conditional required fields', () => {
  const widgets = buildCollection(defineCollection({
    name: 'widgets', mode: 'multi', translatable: false,
    fields: {
      format: { type: 'text', required: true },
      caption: { type: 'text', required: true, condition: { field: 'format', is: 'image' } },
    },
  }))

  function widgetsDb() {
    const database = createTestDb()
    // `caption` is nullable because it is conditional (required only when visible) — mirrors buildTable.
    database.run(sql`CREATE TABLE IF NOT EXISTS widgets (
      id integer PRIMARY KEY AUTOINCREMENT,
      format text NOT NULL,
      caption text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`)
    ensureRevisionsTable(sqliteClientOf(database), 'widgets')
    return database
  }

  it('creates a row with the conditional field hidden (nullable column, no required error)', () => {
    const row = create(widgetsDb(), widgets, { format: 'text' }) as Record<string, unknown>
    expect(row.id).toBeTypeOf('number')
    expect(row.caption ?? null).toBeNull()
  })

  it('rejects an empty conditional field when its condition IS met (required-when-visible)', () => {
    expect(() => create(widgetsDb(), widgets, { format: 'image' })).toThrowError(/Validation failed|required|400/)
  })

  it('accepts the conditional field when visible and filled', () => {
    const row = create(widgetsDb(), widgets, { format: 'image', caption: 'A cat' }) as Record<string, unknown>
    expect(row.caption).toBe('A cat')
  })

  it('update() re-enforces conditional-required on the MERGED record (a patch can make the condition met)', () => {
    const db = widgetsDb()
    const row = create(db, widgets, { format: 'text' }) as Record<string, unknown> // caption hidden, ok
    // PATCH format → 'image' with no caption: the merged record meets the condition but caption is empty
    expect(() => update(db, widgets, row.id as number, { format: 'image' })).toThrowError(/Validation failed|required|400/)
    expect((update(db, widgets, row.id as number, { format: 'image', caption: 'A cat' }) as Record<string, unknown>).caption).toBe('A cat')
  })

  it('putSingleton() re-enforces conditional-required on the merged record', async () => {
    const banner = buildCollection(defineCollection({
      name: 'banner', mode: 'single', translatable: false,
      fields: { format: { type: 'text', required: true }, caption: { type: 'text', required: true, condition: { field: 'format', is: 'image' } } },
    }))
    const db = createTestDb()
    db.run(sql`CREATE TABLE IF NOT EXISTS banner (
      id integer PRIMARY KEY AUTOINCREMENT, singleton_key text NOT NULL,
      format text NOT NULL, caption text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    ensureRevisionsTable(sqliteClientOf(db), 'banner')
    await expect(putSingleton(db, banner, undefined, { format: 'image' })).rejects.toThrowError(/Validation failed|required|400/)
    expect((await putSingleton(db, banner, undefined, { format: 'image', caption: 'Hi' }) as Record<string, unknown>).caption).toBe('Hi')
  })
})

describe('publishedOnly read scope', () => {
  const pagesWithStatus = buildCollection(defineCollection({
    name: 'pages', mode: 'multi', translatable: true, pageLike: true,
    seo: true, blocks: { enabled: true }, status: true,
    fields: { title: { type: 'text', required: true } },
  }))

  it('list with publishedOnly returns only published rows', () => {
    const db = createTestDb()
    ensureRevisionsTable(sqliteClientOf(db), 'pages')
    create(db, pagesWithStatus, { title: 'Draft one' })
    create(db, pagesWithStatus, { title: 'Live one', status: 'published' })

    expect(list(db, pagesWithStatus, {}).total).toBe(2)
    const pub = list(db, pagesWithStatus, {}, true)
    expect(pub.total).toBe(1)
    expect(pub.data[0].title).toBe('Live one')
  })

  it('getOne with publishedOnly 404s a draft but returns a published row', () => {
    const db = createTestDb()
    ensureRevisionsTable(sqliteClientOf(db), 'pages')
    const draft = create(db, pagesWithStatus, { title: 'Hidden' }) as { id: number }
    const live = create(db, pagesWithStatus, { title: 'Shown', status: 'published' }) as { id: number }

    expect(() => getOne(db, pagesWithStatus, draft.id, 0, 'en', true)).toThrow(expect.objectContaining({ _tag: 'NotFound' }) as NotFound)
    expect((getOne(db, pagesWithStatus, live.id, 0, 'en', true) as { title: string }).title).toBe('Shown')
    expect((getOne(db, pagesWithStatus, draft.id, 0, 'en', false) as { title: string }).title).toBe('Hidden')
  })

  it('list $translations honors publishedOnly: a draft sibling is shown in admin scope, hidden in published scope', () => {
    const db = createTestDb()
    ensureRevisionsTable(sqliteClientOf(db), 'pages')
    const en = create(db, pagesWithStatus, { title: 'EN live', status: 'published' }) as Record<string, unknown>
    const de = create(db, pagesWithStatus, { title: 'DE draft', locale: 'de', translationGroup: en.translationGroup as string }) as Record<string, unknown> // draft

    const admin = list(db, pagesWithStatus, {}).data as Array<Record<string, unknown>>
    expect(admin.find((r) => r.id === en.id)!.$translations).toEqual({ en: en.id, de: de.id })

    const pub = list(db, pagesWithStatus, {}, true).data as Array<Record<string, unknown>>
    expect(pub.find((r) => r.id === en.id)!.$translations).toEqual({ en: en.id, de: null })
  })
})

describe('crud — per-row translation status (list aggregation)', () => {
  // Counts real SQL statement preparations so we can assert there is no per-row N+1: a page of N rows
  // must issue a constant number of queries regardless of N. Counts at the raw better-sqlite3 client
  // (`database.$client.prepare`), not the drizzle wrapper's `.select()` — a step behind an ownership
  // adapter (`useContentDbFor`, ADR-0012) builds its own drizzle instance internally over the SAME
  // underlying client, so a `.select` interception on the originally-passed drizzle object would miss
  // those statements entirely while the query count stays identical at the driver level.
  function withSelectCounter(database: ReturnType<typeof createTestDb>) {
    let selects = 0
    const client = (database as unknown as { $client: { prepare: (sql: string) => unknown } }).$client
    const origPrepare = client.prepare.bind(client)
    client.prepare = (sql: string) => {
      if (/^\s*select/i.test(sql)) selects++
      return origPrepare(sql)
    }
    return { db: database, selects: () => selects }
  }

  it('attaches $translations per row: present locales map to their id, missing locales to null', () => {
    const enA = create(db, pagesCollection, { title: 'A' }) as Record<string, unknown>
    const deA = create(db, pagesCollection, { title: 'A-de', locale: 'de', translationGroup: enA.translationGroup as string }) as Record<string, unknown>
    const enB = create(db, pagesCollection, { title: 'B' }) as Record<string, unknown> // en only

    const rows = list(db, pagesCollection, { sort: 'title' }).data as Array<Record<string, unknown>>
    const rowA = rows.find((x) => x.id === enA.id)!
    const rowB = rows.find((x) => x.id === enB.id)!
    expect(rowA.$translations).toEqual({ en: enA.id, de: deA.id })
    expect(rowB.$translations).toEqual({ en: enB.id, de: null })
  })

  it('matches resolveTranslations() for the same row (batched == per-id)', () => {
    const enA = create(db, pagesCollection, { title: 'A' }) as Record<string, unknown>
    create(db, pagesCollection, { title: 'A-de', locale: 'de', translationGroup: enA.translationGroup as string })
    const rows = list(db, pagesCollection, {}).data as Array<Record<string, unknown>>
    expect(rows[0].$translations).toEqual(resolveTranslations(db, pagesCollection, enA.id as number))
  })

  it('locale=all: every variant row carries its full group map', () => {
    const enA = create(db, pagesCollection, { title: 'A' }) as Record<string, unknown>
    const deA = create(db, pagesCollection, { title: 'A-de', locale: 'de', translationGroup: enA.translationGroup as string }) as Record<string, unknown>
    const rows = list(db, pagesCollection, { locale: 'all' }).data as Array<Record<string, unknown>>
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row.$translations).toEqual({ en: enA.id, de: deA.id })
  })

  it('no N+1: a page of N rows issues a constant number of queries', () => {
    for (let i = 0; i < 5; i++) create(db, pagesCollection, { title: `P${i}` }) // 5 separate en-only groups
    const counter = withSelectCounter(db)
    const r = list(counter.db, pagesCollection, {})
    expect(r.data.length).toBe(5)
    // page select + count select + ONE grouped translations select + ONE batched dead-refs select = 4,
    // independent of row count (both sidecars are batched — no N+1).
    expect(counter.selects()).toBe(4)
  })

  it('skips the aggregation query when the page is empty', () => {
    const counter = withSelectCounter(db)
    const r = list(counter.db, pagesCollection, {})
    expect(r.data.length).toBe(0)
    expect(counter.selects()).toBe(2) // page + count only; no aggregation
  })

  it('withTotal:false skips the count() query (the prerender/resolvePage hot path)', () => {
    create(db, pagesCollection, { title: 'A' })
    const counter = withSelectCounter(db)
    const r = list(counter.db, pagesCollection, { withTotal: false })
    expect(r.data.length).toBe(1)
    expect(r.total).toBe(0) // not computed
    expect(counter.selects()).toBe(3) // page + translations agg + dead-refs agg; the count() is skipped
  })

  it('does not attach $translations for a non-translatable collection', () => {
    const media = buildCollection(defineCollection({
      name: 'media', mode: 'multi', translatable: false,
      fields: {
        storageKey: { type: 'text', required: true, unique: true },
        filename: { type: 'text', required: true },
        mime: { type: 'text', required: true },
        ext: { type: 'text', required: true },
        size: { type: 'number', required: true },
      },
    }))
    create(db, media, { storageKey: 'a/x.jpg', filename: 'x.jpg', mime: 'image/jpeg', ext: 'jpg', size: 1 })
    const counter = withSelectCounter(db)
    const r = list(counter.db, media, {})
    expect((r.data[0] as Record<string, unknown>).$translations).toBeUndefined()
    expect(counter.selects()).toBe(2) // no aggregation query for non-translatable collections
  })
})
