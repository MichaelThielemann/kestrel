import { describe, it, expect, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clearPipelines, clearRegistry, defineCollection, desiredSchema, diffSchema, getResolvedKestrelConfig, registerCollection, registerPipeline, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb, buildCollection  } from '@kestrel/core'
import type { BuiltCollection } from '@kestrel/core'
import { callPipelineRoute, usePipelineRouteDb } from '../../../../../test/helpers/pipeline-route.js'
import { buildRoutePipelines } from '../../../src/server/pipelines/route.js'

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true, status: true, fields: { title: { type: 'text' } },
}))
const siteCollection = buildCollection(defineCollection({
  name: 'site', mode: 'single', fields: { title: { type: 'text' } },
}))

interface RouteResponse { collection: string | null; page: { title?: string } | null; site: unknown }

const get = (path: string, role = 'anonymous') =>
  callPipelineRoute('GET', `/api/route?path=${encodeURIComponent(path)}`, { role }) as Promise<RouteResponse>

/** Create tables for `migrated` only — anything left out stands in for a collection the consumer never ran
 *  `db:migrate` for, which is registry-visible but unreadable. */
function build(migrated: BuiltCollection[], registered: BuiltCollection[] = [pages, siteCollection]): Database.Database {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  const db = useDb() as unknown as BetterSQLite3Database
  usePipelineRouteDb(db)
  const sqlite = (db as unknown as { $client: Database.Database }).$client
  const desired = desiredSchema(migrated.map((c) => c.table), new Map(migrated.map((c) => [c.def.name, c.def])))
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  clearRegistry()
  clearPipelines()
  for (const c of registered) registerCollection(c)
  for (const def of buildRoutePipelines()) registerPipeline(def)
  return sqlite
}

function insertPage(sqlite: Database.Database, path: string, status = 'published'): void {
  sqlite.prepare(
    `INSERT INTO pages (locale, translation_group, path, status, title, created_at, updated_at) VALUES ('en', ?, ?, ?, 'T', 0, 0)`,
  ).run(`g-${path}`, path, status)
}

afterEach(() => { clearRegistry(); clearPipelines() })

describe('GET /api/route', () => {
  it('fails the request when the site singleton is unreadable, even though the page resolved', async () => {
    const sqlite = build([pages])
    insertPage(sqlite, '/about')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Answering 200 with `site: null` is indistinguishable from a consumer that ships no head tier, so the
      // publisher would bake the page stripped of its composed title, description and sharing image.
      await expect(get('/about')).rejects.toMatchObject({ statusCode: 503 })
      const messages = spy.mock.calls.map((args) => args.map(String).join(' '))
      expect(messages.some((m) => m.includes('site'))).toBe(true)
    } finally { spy.mockRestore() }
  })

  it('serves the page with site: null when no site collection is registered at all', async () => {
    const sqlite = build([pages], [pages]) // unregistered is the tier's off state, not an incomplete read
    insertPage(sqlite, '/about')
    const res = await get('/about')
    expect(res.collection).toBe('pages')
    expect(res.site).toBeNull()
  })

  it('fails the request when the root resolved nothing while a page lookup was unreadable', async () => {
    const sqlite = build([pages, siteCollection])
    insertPage(sqlite, '/')
    sqlite.exec('DROP TABLE pages') // the lookup now throws instead of returning "no such page"
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A 200 with an empty body here is what the publisher would bake over the live index.html.
      await expect(get('/')).rejects.toMatchObject({ statusCode: 503 })
    } finally { spy.mockRestore() }
  })

  it('serves a genuine miss as an empty resolution, not a failure', async () => {
    build([pages, siteCollection])
    const res = await get('/nothing-here')
    expect(res.collection).toBeNull()
    expect(res.page).toBeNull()
  })
})

describe('GET /api/route — the read scope follows the principal', () => {
  it('hides a draft from an anonymous visitor but renders it for an admin at its real URL', async () => {
    const sqlite = build([pages, siteCollection])
    insertPage(sqlite, '/secret', 'draft')
    expect((await get('/secret')).page).toBeNull()
    expect((await get('/secret', 'admin')).collection).toBe('pages')
  })

  it('keeps the renderer published-only, so a draft never reaches the static site', async () => {
    const sqlite = build([pages, siteCollection])
    insertPage(sqlite, '/secret', 'draft')
    expect((await get('/secret', 'renderer')).page).toBeNull()
  })

  it('is readable without a session — an anonymous visitor gets the published page', async () => {
    const sqlite = build([pages, siteCollection])
    insertPage(sqlite, '/about')
    expect((await get('/about')).collection).toBe('pages')
  })

  it('is a read pipeline: a POST to the same URL is refused', async () => {
    build([pages, siteCollection])
    await expect(callPipelineRoute('POST', '/api/route', { body: {} })).rejects.toMatchObject({ statusCode: 405 })
  })
})
