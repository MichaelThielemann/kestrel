import { describe, it, expect, vi, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import { buildLlmsTxt } from '../utils/llms'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'

// The route is a server route driven by auto-imports; stub them as globals (the same seam the Nitro
// build provides) so the handler can be exercised as a plain function.
const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true, status: true, seo: true,
  blocks: { enabled: true }, fields: { title: { type: 'text' } },
}))
// The lean schema variant: no locale/status/seo columns exist on this table, and no `title` field either.
const landing = buildCollection(defineCollection({
  name: 'landing', mode: 'multi', translatable: false, pageLike: true, fields: { headline: { type: 'text' } },
}))

let db: BetterSQLite3Database
let sqlite: Database.Database
const selectArgs: unknown[][] = []
let handler: (event: unknown) => unknown

function insert(row: { path: string; status: string; locale?: string; content?: string; seo?: string }): void {
  sqlite.prepare(
    `INSERT INTO pages (locale, translation_group, path, status, title, seo, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1000)`,
  ).run(row.locale ?? 'en', `g-${row.path}`, row.path, row.status, `T ${row.path}`, row.seo ?? '{}', row.content ?? '[]')
}

beforeAll(async () => {
  sqlite = new Database(':memory:')
  const desired = desiredSchema([pages.table, landing.table], new Map([[pages.def.name, pages.def], [landing.def.name, landing.def]]))
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  const spyDb = { select: (...args: unknown[]) => { selectArgs.push(args); return (db.select as (...a: unknown[]) => unknown)(...args) } }
  vi.stubGlobal('defineEventHandler', (h: (event: unknown) => unknown) => h)
  vi.stubGlobal('useDb', () => spyDb)
  vi.stubGlobal('siteBaseUrl', () => 'https://example.test')
  vi.stubGlobal('siteName', () => 'Example')
  vi.stubGlobal('siteDescription', () => '')
  vi.stubGlobal('primaryLocale', () => 'en')
  vi.stubGlobal('prefixPrimaryLocale', () => false)
  vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages])
  vi.stubGlobal('publicReadableResources', () => ['pages'])
  vi.stubGlobal('isPubliclyReadable', () => true)
  vi.stubGlobal('buildLlmsTxt', buildLlmsTxt)
  vi.stubGlobal('setHeader', () => {})
  handler = (await import('./llms.txt.get')).default as (event: unknown) => unknown
})

describe('llms.txt route', () => {
  it('lists published, indexable pages with their titles', () => {
    insert({ path: '/about', status: 'published', locale: 'en' })
    insert({ path: '/ueber-uns', status: 'published', locale: 'de' })
    insert({ path: '/secret', status: 'draft' })
    insert({ path: '/hidden', status: 'published', seo: JSON.stringify({ noindex: true }) })
    const txt = handler({}) as string
    expect(txt).toContain('[T /about](https://example.test/about)')
    expect(txt).toContain('](https://example.test/de/ueber-uns)')
    expect(txt).not.toContain('/secret')
    expect(txt).not.toContain('/hidden')
  })

  it('projects only the columns it needs — never SELECT *, which would pull every row\'s block content into memory', () => {
    selectArgs.length = 0
    insert({ path: '/heavy', status: 'published', content: JSON.stringify([{ id: 'a', type: 'hero', props: { x: 'y'.repeat(1000) } }]) })
    handler({})
    expect(selectArgs.length).toBe(1)
    const proj = selectArgs[0]![0] as Record<string, unknown> | undefined
    expect(proj).toBeDefined()
    expect(Object.keys(proj!).sort()).toEqual(['locale', 'path', 'seo', 'status', 'title'])
  })

  it('still lists a collection whose table has no locale/status/seo/title columns (the projection is flag-gated)', () => {
    sqlite.prepare(`INSERT INTO landing (path, headline, created_at, updated_at) VALUES ('/promo', 'H', 0, 1000)`).run()
    vi.stubGlobal('allCollections', (): BuiltCollection[] => [landing])
    const txt = handler({}) as string
    vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages])
    // no title field → the path is the fallback link text
    expect(txt).toContain('[/promo](https://example.test/promo)')
  })
})
