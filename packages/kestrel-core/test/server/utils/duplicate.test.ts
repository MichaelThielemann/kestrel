import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql, eq, getTableColumns } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { withCopySuffix } from '../../../src/server/utils/duplicate.js'
import { create, duplicateRecord } from '../../../src/server/utils/crud.js'
import { buildCollection } from '../../../src/server/schema/buildCollection.js'
import { defineCollection, getResolvedKestrelConfig, setResolvedKestrelConfig, resetDbInstance, useDb } from '../../../src/index.js'
import type { ContentDb } from '../../../src/server/db/content-db.js'
import { registerBlock, clearBlocks } from '../../../src/server/blocks/registry.js'
import { clearRegistry, registerCollection } from '../../../src/server/utils/registry.js'
import { clearPipelines } from '../../../src/server/pipeline/registry.js'
import { findReferrers } from '../../../src/server/utils/record-ref-index.js'
import { clearOutboxHandlers, pollOnce } from '../../../src/server/db/outbox-worker.js'
import { registerReindexRefs } from '../../../src/server/handlers/reindex-refs.js'
import type { createTestDb } from '../../../../../test/helpers/db.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { ensureRevisionsTable, revisionsTable } from '../../../src/server/db/revisions.js'
import { sqliteClientOf } from '../../../src/server/db/outbox.js'
import { pagesCollection } from '@michaelthielemann/kestrel-collections'
import { mediaCollection } from '@michaelthielemann/kestrel-media'

type Row = Record<string, unknown>

// A plain multi collection carrying every reference-bearing column type — for the "shared, never cloned"
// + refs-reindex assertions. (relation → itself is fine: only the id is stored.)
const things = buildCollection(defineCollection({
  name: 'things',
  mode: 'multi',
  status: true,
  fields: {
    title: { type: 'text', required: true },
    cover: { type: 'media' },
    related: { type: 'relation', relation: { collection: 'things', many: true } },
    link: { type: 'link' },
  },
}))

// Unique fields: a `slug` re-derives from the suffixed source; a non-required unique `code` clears to NULL.
const gal = buildCollection(defineCollection({
  name: 'gal',
  mode: 'multi',
  fields: {
    title: { type: 'text', required: true },
    slug: { type: 'slug', unique: true, options: { from: 'title' } },
    code: { type: 'text', unique: true },
  },
}))

// A collection whose REQUIRED UNIQUE non-slug field can't be reconciled → the 422 pre-flight.
const badges = buildCollection(defineCollection({
  name: 'badges',
  mode: 'multi',
  fields: {
    title: { type: 'text', required: true },
    code: { type: 'text', required: true, unique: true },
  },
}))

const settings = buildCollection(defineCollection({
  name: 'settings2',
  mode: 'single',
  fields: { siteName: { type: 'text' } },
}))

// The slug-source text field itself carries `unique` and is NOT required: the `(copy)` suffix already makes
// it distinct, so it must be KEPT (never nulled) — pageLike, so nulling would also strand the slug derive.
const uposts = buildCollection(defineCollection({
  name: 'uposts',
  mode: 'multi',
  translatable: false,
  pageLike: true,
  fields: { title: { type: 'text', unique: true } },
}))

// A required title with a maxLength: a record AT the limit must still duplicate (the suffix is budgeted in).
const capped = buildCollection(defineCollection({
  name: 'capped',
  mode: 'multi',
  fields: { title: { type: 'text', required: true, options: { maxLength: 60 } } },
}))

// A pageLike collection with NO text field: its records carry an EXPLICIT path (nothing to auto-derive from).
const boards = buildCollection(defineCollection({
  name: 'boards',
  mode: 'multi',
  translatable: false,
  pageLike: true,
  fields: { order: { type: 'number' } },
}))

function colsOf(table: unknown): Record<string, AnySQLiteColumn> {
  return getTableColumns(table as never) as Record<string, AnySQLiteColumn>
}

function expectStatus(fn: () => unknown, code: number): { statusCode?: number; statusMessage?: string } {
  try {
    fn()
  } catch (e) {
    expect((e as { statusCode?: number }).statusCode).toBe(code)
    return e as { statusCode?: number; statusMessage?: string }
  }
  throw new Error(`expected a ${code} error, but none was thrown`)
}

const migrationsFolder = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)), 'server/database/migrations')

let db: ReturnType<typeof createTestDb>
beforeEach(() => {
  // `duplicateRecord`'s reindexRefs after-step (via `useContentDb`) reads the shared `useDb()` singleton —
  // point it at a fresh in-memory db each test (reset + re-migrate, mirroring `createTestDb()`).
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  db = useDb()
  migrate(db, { migrationsFolder })
  // Migrations give us pages / media / record_refs; the custom test tables are layered on top.
  for (const stmt of renderSqlite(diffSchema(desiredSchema([
    things.table, gal.table, badges.table, uposts.table, capped.table, boards.table,
    revisionsTable('things'), revisionsTable('gal'), revisionsTable('badges'),
    revisionsTable('uposts'), revisionsTable('capped'), revisionsTable('boards'),
  ]), {}))) {
    db.run(sql.raw(stmt))
  }
  ensureRevisionsTable(sqliteClientOf(db), 'pages')
  ensureRevisionsTable(sqliteClientOf(db), 'media')
  clearRegistry()
  registerCollection(pagesCollection)
  registerCollection(things)
  // pageLike collections must be registered so the global route-conflict scan (allCollections()) sees them.
  registerCollection(uposts)
  registerCollection(boards)
  registerCollection(capped)
  clearBlocks()
  registerBlock({ name: 'hero', fields: { title: { type: 'text' } } })
  registerBlock({ name: 'wrap', fields: {}, slots: ['default'] })
  clearPipelines()
  clearOutboxHandlers()
  registerReindexRefs()
})
afterEach(() => {
  clearBlocks()
  clearRegistry()
  clearOutboxHandlers()
})

describe('withCopySuffix', () => {
  it('appends and then increments the (copy) suffix', () => {
    expect(withCopySuffix('Home')).toBe('Home (copy)')
    expect(withCopySuffix('Home (copy)')).toBe('Home (copy 2)')
    expect(withCopySuffix('Home (copy 2)')).toBe('Home (copy 3)')
    expect(withCopySuffix('Home (copy 3)')).toBe('Home (copy 4)')
    expect(withCopySuffix('A (copy 10)')).toBe('A (copy 11)')
  })
  it('handles an empty source without a stray leading space', () => {
    expect(withCopySuffix('')).toBe('(copy)')
  })

  describe('with a maxLength budget', () => {
    it('leaves a result that already fits untouched', () => {
      expect(withCopySuffix('Home', 11)).toBe('Home (copy)') // exactly 11
      expect(withCopySuffix('Home', 100)).toBe('Home (copy)')
    })

    it('truncates the base so base + suffix fits exactly', () => {
      // 'Home (copy)' is 11 > 10 → drop 1 base char: 'Hom (copy)' (10).
      expect(withCopySuffix('Home', 10)).toBe('Hom (copy)')
      const sixty = 'A'.repeat(60)
      const out = withCopySuffix(sixty, 60)
      expect(out.length).toBe(60)
      expect(out).toBe(`${'A'.repeat(53)} (copy)`)
    })

    it('trims a trailing space left by truncation (no "ab  (copy)")', () => {
      // maxLength 10: base room = 10 - 6 - 1 = 3 → 'ab cd'.slice(0,3) = 'ab ' → trimEnd → 'ab'.
      expect(withCopySuffix('ab cd', 10)).toBe('ab (copy)')
    })

    it('drops the suffix entirely when it cannot fit at all', () => {
      expect(withCopySuffix('Hello', 5)).toBe('Hello') // '(copy)' is 6 > 5
      expect(withCopySuffix('Hello', 6)).toBe('(copy)') // '(copy)' fits exactly as the whole value
    })

    it('keeps the (copy N) increment rule working under truncation', () => {
      // Re-duplicating a truncated copy still increments the counter (and re-budgets).
      expect(withCopySuffix('Hom (copy)', 12)).toBe('Hom (copy 2)') // 12 fits exactly
      expect(withCopySuffix('Hom (copy)', 11)).toBe('Ho (copy 2)') // one char trimmed off the base
    })
  })
})

describe('duplicateRecord — plain collection (verbatim scalar copy, fresh identity)', () => {
  it('gives the copy a new id + fresh timestamps and copies scalar values verbatim', () => {
    const src = create(db, things, { title: 'A', status: 'published' }) as Row
    const copy = duplicateRecord(db, things, src.id as number)
    expect(copy.id).not.toBe(src.id)
    expect(typeof copy.id).toBe('number')
    expect(copy.createdAt).toBeInstanceOf(Date)
    // A copy of a PUBLISHED record lands as a draft.
    expect(copy.status).toBe('draft')
    // The slug-source text field gets the (copy) suffix.
    expect(copy.title).toBe('A (copy)')
  })
})

describe('duplicateRecord — references are SHARED, never deep-copied, and reindexed', () => {
  it('copies relation/media/link FKs by value and rebuilds record_refs for the new id', async () => {
    const src = create(db, things, {
      title: 'Refful',
      coverId: 7,
      related: [1, 2],
      link: { type: 'internal', collection: 'things', id: 3 },
    }) as Row
    const copy = duplicateRecord(db, things, src.id as number)
    const copyId = copy.id as number

    // Shared by value — the same target ids, never a new media/relation row.
    expect(copy.coverId).toBe(7)
    expect(copy.related).toEqual([1, 2])
    expect(copy.link).toEqual({ type: 'internal', collection: 'things', id: 3 })

    // reindexRefs (the outbox handler) rebuilds the forward edges for the NEW row once polled — no extra
    // work in duplicate itself.
    await pollOnce(db, 'content')
    // `findReferrers` takes the branded `ContentDb`; `db` above stays `BetterSQLite3Database`
    // for `create`/`duplicateRecord`, so this is the one cast site vouching for the brand here.
    const contentDb = db as unknown as ContentDb
    expect(findReferrers(contentDb, 'media', 7)).toContainEqual({ collection: 'things', id: copyId })
    expect(findReferrers(contentDb, 'things', 1)).toContainEqual({ collection: 'things', id: copyId })
    expect(findReferrers(contentDb, 'things', 3)).toContainEqual({ collection: 'things', id: copyId })
  })
})

describe('duplicateRecord — pageLike (draft, re-derived slug, de-dup)', () => {
  it('lands a published page as a draft with a (copy) title and a slug from the suffixed title', () => {
    const src = create(db, pagesCollection, { title: 'Home', path: '/home', status: 'published' }) as Row
    const copy = duplicateRecord(db, pagesCollection, src.id as number)
    expect(copy.status).toBe('draft')
    expect(copy.title).toBe('Home (copy)')
    expect(copy.path).toBe('/home-copy')
  })

  it('de-dupes the derived path when it is already taken', () => {
    const src = create(db, pagesCollection, { title: 'Blog', path: '/blog', status: 'published' }) as Row
    const first = duplicateRecord(db, pagesCollection, src.id as number)
    const second = duplicateRecord(db, pagesCollection, src.id as number)
    expect(first.path).toBe('/blog-copy')
    expect(second.path).toBe('/blog-copy-2')
  })

  it('increments the (copy) suffix on a copy of a copy (title and slug)', () => {
    const src = create(db, pagesCollection, { title: 'News', path: '/news' }) as Row
    const copy1 = duplicateRecord(db, pagesCollection, src.id as number)
    const copy2 = duplicateRecord(db, pagesCollection, copy1.id as number)
    expect(copy1.title).toBe('News (copy)')
    expect(copy2.title).toBe('News (copy 2)')
    expect(copy1.path).toBe('/news-copy')
    expect(copy2.path).toBe('/news-copy-2')
  })
})

describe('duplicateRecord — blocks (every id regenerated, structure preserved)', () => {
  it('regenerates block ids at every depth, disjoint from the source, props preserved', () => {
    const content = [
      { id: 'b1', type: 'hero', props: { title: 'Hi' } },
      {
        id: 'b2', type: 'wrap', props: {},
        slots: { default: [{ id: 'b3', type: 'hero', props: { title: 'Deep' } }] },
      },
    ]
    const src = create(db, pagesCollection, { title: 'Blocky', path: '/blocky', content }) as Row
    const copy = duplicateRecord(db, pagesCollection, src.id as number)

    const collect = (nodes: unknown): string[] => {
      if (!Array.isArray(nodes)) return []
      const out: string[] = []
      for (const n of nodes as Array<{ id?: string; slots?: Record<string, unknown> }>) {
        if (typeof n.id === 'string') out.push(n.id)
        if (n.slots) for (const arr of Object.values(n.slots)) out.push(...collect(arr))
      }
      return out
    }
    const copyIds = collect(copy.content)
    expect(copyIds).toHaveLength(3)
    expect(new Set(copyIds).size).toBe(3)
    for (const id of ['b1', 'b2', 'b3']) expect(copyIds).not.toContain(id)

    // Block structure + props survive verbatim.
    const blocks = copy.content as Array<{ type: string; props: Record<string, unknown>; slots?: { default?: Array<{ props: Record<string, unknown> }> } }>
    expect(blocks[0]!.type).toBe('hero')
    expect(blocks[0]!.props).toEqual({ title: 'Hi' })
    expect(blocks[1]!.slots!.default![0]!.props).toEqual({ title: 'Deep' })
  })
})

describe('duplicateRecord — translatable (Option A: lone row in a new group)', () => {
  it('mints a new translationGroup holding only the source locale', () => {
    const src = create(db, pagesCollection, { title: 'Trans', path: '/trans', status: 'published' }) as Row
    const copy = duplicateRecord(db, pagesCollection, src.id as number)

    expect(copy.translationGroup).not.toBe(src.translationGroup)
    expect(copy.locale).toBe(src.locale)

    const cols = colsOf(pagesCollection.table)
    const members = db.select().from(pagesCollection.table as never)
      .where(eq(cols.translationGroup, copy.translationGroup as string)).all() as Row[]
    expect(members).toHaveLength(1)
    expect(members[0]!.id).toBe(copy.id)
  })

  it('keeping the source group would violate UNIQUE(group, locale) → 409 (why Option A is forced)', () => {
    const src = create(db, pagesCollection, { title: 'Grp', path: '/grp' }) as Row
    expect(() => create(db, pagesCollection, { title: 'Grp2', path: '/grp2', locale: src.locale, translationGroup: src.translationGroup }))
      .toThrowError(expect.objectContaining({ _tag: 'Conflict', field: 'locale' }))
  })
})

describe('duplicateRecord — unique fields', () => {
  it('regenerates a unique slug from the suffixed title and clears a non-required unique field to NULL', () => {
    const src = create(db, gal, { title: 'Wedding', code: 'ABC' }) as Row
    expect(src.slug).toBe('wedding')
    const copy = duplicateRecord(db, gal, src.id as number)
    expect(copy.title).toBe('Wedding (copy)')
    expect(copy.slug).toBe('wedding-copy')
    expect(copy.code).toBeNull()
  })

  it('de-dupes the slug with -N when the SAME record is duplicated twice (no unique-slug 400)', () => {
    const src = create(db, gal, { title: 'Wedding', code: null }) as Row
    const first = duplicateRecord(db, gal, src.id as number)
    expect(first.slug).toBe('wedding-copy')
    // The second copy of the SAME source would derive `wedding-copy` again → must de-dupe, not 400.
    const second = duplicateRecord(db, gal, src.id as number)
    expect(second.slug).toBe('wedding-copy-2')
    const third = duplicateRecord(db, gal, src.id as number)
    expect(third.slug).toBe('wedding-copy-3')
  })

  it('refuses (422, naming the field) a required unique non-slug field that would collide', () => {
    const src = create(db, badges, { title: 'Gold', code: 'G-1' }) as Row
    const err = expectStatus(() => duplicateRecord(db, badges, src.id as number), 422)
    expect(err.statusMessage).toMatch(/code/)
  })

  // h3 strips everything outside printable ASCII from `statusMessage` (it is a header value), so a
  // message carrying typographic punctuation reaches the admin mangled.
  it('states the refusal in characters that survive a status line', () => {
    const src = create(db, badges, { title: 'Gold', code: 'G-1' }) as Row
    const err = expectStatus(() => duplicateRecord(db, badges, src.id as number), 422)
    expect(err.statusMessage).toMatch(/^[\t -~]*$/)
  })
})

describe('duplicateRecord — the slug-source field is exempt from unique-blanking', () => {
  it('keeps a NON-required UNIQUE slug-source title (suffixed), never nulling it, and derives its slug', () => {
    // Blanking it like other unique fields would be silent data loss, and (pageLike) leave no title to derive a path from → 400.
    const src = create(db, uposts, { title: 'Hello' }) as Row
    expect(src.path).toBe('/hello')
    const copy = duplicateRecord(db, uposts, src.id as number)
    expect(copy.title).toBe('Hello (copy)')
    expect(copy.path).toBe('/hello-copy')
  })
})

describe('duplicateRecord — the (copy) suffix is budgeted against the title maxLength', () => {
  it('duplicates a record whose title is exactly at its maxLength (no 400 from the re-validated .max)', () => {
    const sixty = 'A'.repeat(60)
    const src = create(db, capped, { title: sixty }) as Row
    const copy = duplicateRecord(db, capped, src.id as number)
    expect((copy.title as string).length).toBeLessThanOrEqual(60)
    expect(copy.title).toBe(`${'A'.repeat(53)} (copy)`)
  })
})

describe('duplicateRecord — pageLike collection with no slug-source text field', () => {
  it('seeds the copy path off the source explicit path, de-duped (no 400)', () => {
    const src = create(db, boards, { path: '/board-a', order: 1 }) as Row
    expect(src.path).toBe('/board-a')
    const copy = duplicateRecord(db, boards, src.id as number)
    expect(copy.path).toBe('/board-a-2')
    expect(copy.order).toBe(1)
    // A second copy walks to the next free route.
    const copy2 = duplicateRecord(db, boards, src.id as number)
    expect(copy2.path).toBe('/board-a-3')
  })
})

describe('duplicateRecord — guards', () => {
  it('404s on an unknown id', () => {
    expectStatus(() => duplicateRecord(db, things, 99999), 404)
  })
  it('405s on a singleton collection', () => {
    expectStatus(() => duplicateRecord(db, settings, 1), 405)
  })
  it('422s a media record (required unique storageKey) before touching the DB', () => {
    const m = create(db, mediaCollection, { storageKey: 'k1', filename: 'a.png', mime: 'image/png', ext: 'png', size: 10 }) as Row
    const err = expectStatus(() => duplicateRecord(db, mediaCollection, m.id as number), 422)
    expect(err.statusMessage).toMatch(/storageKey/)
  })
})
