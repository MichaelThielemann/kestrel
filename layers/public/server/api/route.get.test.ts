import { describe, it, expect, vi } from 'vitest'
import { createError } from 'h3'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { getSingleton } from '../../../core/server/utils/crud'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'

interface FakeEvent { query: Record<string, unknown>; context: Record<string, unknown> }

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true, status: true, fields: { title: { type: 'text' } },
}))
const siteCollection = buildCollection(defineCollection({
  name: 'site', mode: 'single', fields: { title: { type: 'text' } },
}))

let db: BetterSQLite3Database
let collections: BuiltCollection[] = []
let siteRegistered = true

Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery: (event: FakeEvent) => event.query,
  useDb: () => db,
  allCollections: () => collections,
  getCollection: (name: string) => (name === 'site' && siteRegistered ? siteCollection : null),
  getSingleton,
  isRendererContext: () => false,
})

const handler = (await import('./route.get')).default as unknown as (event: FakeEvent) => { collection: string | null; page: unknown; site: unknown }
const get = (path: string) => handler({ query: { path }, context: {} })

/** Create tables for `migrated` only — anything left out stands in for a collection the consumer never ran
 *  `db:migrate` for, which is registry-visible but unreadable. */
function build(migrated: BuiltCollection[]): Database.Database {
  const sqlite = new Database(':memory:')
  const desired = desiredSchema(migrated.map((c) => c.table), new Map(migrated.map((c) => [c.def.name, c.def])))
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  collections = [pages]
  siteRegistered = true
  return sqlite
}

function insertPage(sqlite: Database.Database, path: string): void {
  sqlite.prepare(
    `INSERT INTO pages (locale, translation_group, path, status, title, created_at, updated_at) VALUES ('en', ?, ?, 'published', 'T', 0, 0)`,
  ).run(`g-${path}`, path)
}

function statusOf(fn: () => unknown): number | undefined {
  try { fn() } catch (error) { return (error as { statusCode?: number }).statusCode }
  return undefined
}

describe('GET /api/route', () => {
  it('fails the request when the site singleton is unreadable, even though the page resolved', () => {
    const sqlite = build([pages])
    insertPage(sqlite, '/about')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Answering 200 with `site: null` is indistinguishable from a consumer that ships no head tier, so the
      // publisher would bake the page stripped of its composed title, description and sharing image.
      expect(statusOf(() => get('/about'))).toBe(503)
      const messages = spy.mock.calls.map((args) => args.map(String).join(' '))
      expect(messages.some((m) => m.includes('site'))).toBe(true)
    } finally { spy.mockRestore() }
  })

  it('serves the page with site: null when no site collection is registered at all', () => {
    const sqlite = build([pages])
    insertPage(sqlite, '/about')
    siteRegistered = false // unregistered is the tier's off state, not an incomplete read
    const res = get('/about')
    expect(res.collection).toBe('pages')
    expect(res.site).toBeNull()
  })

  it('fails the request when the root resolved nothing while a page lookup was unreadable', () => {
    const sqlite = build([pages, siteCollection])
    insertPage(sqlite, '/')
    sqlite.exec('DROP TABLE pages') // the lookup now throws instead of returning "no such page"
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A 200 with an empty body here is what the publisher would bake over the live index.html.
      expect(statusOf(() => get('/'))).toBe(503)
    } finally { spy.mockRestore() }
  })

  it('serves a genuine miss as an empty resolution, not a failure', () => {
    build([pages, siteCollection])
    const res = get('/nothing-here')
    expect(res.collection).toBeNull()
    expect(res.page).toBeNull()
  })
})
