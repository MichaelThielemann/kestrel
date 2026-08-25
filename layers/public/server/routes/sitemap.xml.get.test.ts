import { describe, it, expect, vi, beforeAll } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '@kestrel/core'
import { clearRegistry, defineCollection, desiredSchema, diffSchema, getResolvedKestrelConfig, registerCollection, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb } from '@kestrel/core'
// The route is a server route driven by auto-imports (Nitro's `server/utils` convention); stub those as
// globals so the handler can be exercised as a plain function. `siteBaseUrl` is an explicit
// `@kestrel/publishing` import, mocked accordingly.
vi.mock('@kestrel/publishing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kestrel/publishing')>()),
  siteBaseUrl: () => 'https://example.test',
}))
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
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  db = useDb() as unknown as BetterSQLite3Database
  sqlite = (db as unknown as { $client: Database.Database }).$client
  const desired = desiredSchema(
    [pages.table, landing.table, drifted.table],
    new Map([[pages.def.name, pages.def], [landing.def.name, landing.def], [drifted.def.name, drifted.def]]),
  )
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  vi.spyOn(db, 'select').mockImplementation((...args: unknown[]) => {
    selectArgs.push(args)
    return (Object.getPrototypeOf(db).select as (...a: unknown[]) => unknown).apply(db, args)
  })
  clearRegistry()
  registerCollection(pages)
  vi.stubGlobal('defineEventHandler', (h: (event: unknown) => unknown) => h)
  vi.stubGlobal('primaryLocale', () => 'en')
  vi.stubGlobal('prefixPrimaryLocale', () => false)
  vi.stubGlobal('publicReadableResources', () => ['pages'])
  vi.stubGlobal('isPubliclyReadable', () => true)
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
    clearRegistry()
    registerCollection(landing)
    const xml = handler({}) as string
    clearRegistry()
    registerCollection(pages)
    expect(xml).toContain('<loc>https://example.test/promo</loc>')
  })

  it('logs the collection it skipped when its table is unreadable, instead of silently de-indexing its pages', () => {
    sqlite.prepare(`INSERT INTO drifted (path, status, title, seo, created_at, updated_at) VALUES ('/gone', 'published', 'T', '{}', 0, 1000)`).run()
    sqlite.exec('ALTER TABLE drifted DROP COLUMN seo')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    clearRegistry()
    registerCollection(pages)
    registerCollection(drifted)
    try {
      const xml = handler({}) as string
      expect(xml).not.toContain('/gone') // the gap itself stays — a bare prerender DB must not fail the publish
      expect(xml).toContain('<loc>https://example.test/about</loc>')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('sitemap.xml: skipped collection drifted'), expect.anything())
    } finally {
      error.mockRestore()
      clearRegistry()
      registerCollection(pages)
    }
  })
})
