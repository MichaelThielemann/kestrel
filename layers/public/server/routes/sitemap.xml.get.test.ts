import { describe, it, expect, vi, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import { buildSitemap, withHreflang } from '../utils/sitemap'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'

// The route is a server route driven by auto-imports; stub them as globals (the same seam the Nitro
// build provides) so the handler can be exercised as a plain function.
const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true, status: true, seo: true,
  blocks: { enabled: true }, fields: { title: { type: 'text' } },
}))
// The lean schema variant: no locale/translationGroup/status/seo columns exist on this table at all.
const landing = buildCollection(defineCollection({
  name: 'landing', mode: 'multi', translatable: false, pageLike: true, fields: { title: { type: 'text' } },
}))
// Its table gets a projected column dropped mid-test, so the read throws like a drifted/unmigrated DB.
const drifted = buildCollection(defineCollection({
  name: 'drifted', mode: 'multi', translatable: false, pageLike: true, status: true, seo: true,
  fields: { title: { type: 'text' } },
}))

let db: BetterSQLite3Database
let sqlite: Database.Database
const selectArgs: unknown[][] = []
let handler: (event: unknown) => unknown

function insert(row: { path: string; status: string; locale?: string; group?: string; content?: string }): void {
  sqlite.prepare(
    `INSERT INTO pages (locale, translation_group, path, status, title, seo, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '{}', ?, 0, 1000)`,
  ).run(row.locale ?? 'en', row.group ?? `g-${row.path}`, row.path, row.status, 'T', row.content ?? '[]')
}

beforeAll(async () => {
  sqlite = new Database(':memory:')
  const desired = desiredSchema(
    [pages.table, landing.table, drifted.table],
    new Map([[pages.def.name, pages.def], [landing.def.name, landing.def], [drifted.def.name, drifted.def]]),
  )
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  const spyDb = { select: (...args: unknown[]) => { selectArgs.push(args); return (db.select as (...a: unknown[]) => unknown)(...args) } }
  vi.stubGlobal('defineEventHandler', (h: (event: unknown) => unknown) => h)
  vi.stubGlobal('useDb', () => spyDb)
  vi.stubGlobal('siteBaseUrl', () => 'https://example.test')
  vi.stubGlobal('primaryLocale', () => 'en')
  vi.stubGlobal('prefixPrimaryLocale', () => false)
  vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages])
  vi.stubGlobal('publicReadableResources', () => ['pages'])
  vi.stubGlobal('isPubliclyReadable', () => true)
  vi.stubGlobal('withHreflang', withHreflang)
  vi.stubGlobal('buildSitemap', buildSitemap)
  vi.stubGlobal('setHeader', () => {})
  handler = (await import('./sitemap.xml.get')).default as (event: unknown) => unknown
})

describe('sitemap.xml route', () => {
  it('lists published, indexable pages with hreflang alternates', () => {
    insert({ path: '/about', status: 'published', locale: 'en', group: 'g1' })
    insert({ path: '/ueber-uns', status: 'published', locale: 'de', group: 'g1' })
    insert({ path: '/secret', status: 'draft' })
    const xml = handler({}) as string
    expect(xml).toContain('<loc>https://example.test/about</loc>')
    expect(xml).toContain('<loc>https://example.test/de/ueber-uns</loc>')
    expect(xml).not.toContain('/secret')
    expect(xml).toContain('hreflang="de"')
    expect(xml).toContain('<lastmod>1970-01-01T00:00:01.000Z</lastmod>')
  })

  it('projects only the columns it needs — never SELECT *, which would pull every row\'s block content into memory', () => {
    selectArgs.length = 0
    insert({ path: '/heavy', status: 'published', content: JSON.stringify([{ id: 'a', type: 'hero', props: { x: 'y'.repeat(1000) } }]) })
    handler({})
    expect(selectArgs.length).toBe(1)
    const proj = selectArgs[0]![0] as Record<string, unknown> | undefined
    expect(proj).toBeDefined()
    expect(Object.keys(proj!).sort()).toEqual(['locale', 'path', 'seo', 'status', 'translationGroup', 'updatedAt'])
  })

  it('still lists a collection whose table has no locale/status/seo columns (the projection is flag-gated)', () => {
    sqlite.prepare(`INSERT INTO landing (path, title, created_at, updated_at) VALUES ('/promo', 'T', 0, 1000)`).run()
    vi.stubGlobal('allCollections', (): BuiltCollection[] => [landing])
    const xml = handler({}) as string
    vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages])
    expect(xml).toContain('<loc>https://example.test/promo</loc>')
  })

  it('logs the collection it skipped when its table is unreadable, instead of silently de-indexing its pages', () => {
    sqlite.prepare(`INSERT INTO drifted (path, status, title, seo, created_at, updated_at) VALUES ('/gone', 'published', 'T', '{}', 0, 1000)`).run()
    sqlite.exec('ALTER TABLE drifted DROP COLUMN seo')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages, drifted])
    try {
      const xml = handler({}) as string
      expect(xml).not.toContain('/gone') // the gap itself stays — a bare prerender DB must not fail the publish
      expect(xml).toContain('<loc>https://example.test/about</loc>')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('sitemap.xml: skipped collection drifted'), expect.anything())
    } finally {
      error.mockRestore()
      vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages])
    }
  })
})
