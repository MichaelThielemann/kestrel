import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createError } from 'h3'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { parseIdList } from '../../../core/server/utils/http'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import { DepsStore } from '../utils/publish/deps'
import { setPublishRuntime } from '../utils/publish/publish-runtime'
import type { Invalidation } from '../utils/publish/invalidation'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'

// The endpoint asks the publisher which routes are live (to spot a record's abandoned old URL); the real
// module reaches for the storage drivers and the built output, none of which a node test has.
const live = { routes: ['/', '/kept'], savedAt: new Map<string, number>(), failed: [] as string[] }
vi.mock('../utils/publish/publisher', () => ({ allPublishedRoutes: () => live }))

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true, fields: { title: { type: 'text' } },
}))

interface FakeEvent { context: Record<string, unknown> }

let db: BetterSQLite3Database
let sqlite: Database.Database
let body: Record<string, unknown>
let enqueued: Invalidation[]
let auto: boolean

Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  readBody: async () => body,
  requireAdmin: (event: FakeEvent) => {
    if (event.context.principal !== 'admin') throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  },
  getCollection: (name: string) => (name === 'pages' ? pages : null),
  useDb: () => db,
  parseIdList,
  primaryLocale: () => 'en',
  prefixPrimaryLocale: () => false,
  useRuntimeConfig: () => ({ kestrel: { output: { auto } } }),
})

const handler = (await import('./publish.post')).default as unknown as (event: FakeEvent) => Promise<Record<string, unknown>>
const post = (b: Record<string, unknown>) => { body = b; return handler({ context: { principal: 'admin' } }) }

function insert(id: number, path: string, status: string): void {
  sqlite.prepare('INSERT INTO pages (id, path, status, title, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)').run(id, path, status, `T${id}`)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  const desired = desiredSchema([pages.table], new Map([['pages', pages.def]]) as never)
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  enqueued = []
  auto = true
  live.routes = ['/', '/kept']
  live.failed = []
  setPublishRuntime({ queue: { enqueue: (inv) => enqueued.push(inv) }, deps: new DepsStore() })
})

async function statusOf(fn: () => Promise<unknown>): Promise<number | undefined> {
  try { await fn() } catch (error) { return (error as { statusCode?: number }).statusCode }
  return undefined
}

describe('POST /api/publish — the explicit "write the static file" action', () => {
  it('enqueues the record\'s own route plus the pages that embed it', async () => {
    insert(1, '/kept', 'published')
    const res = await post({ collection: 'pages', ids: [1] })
    expect(enqueued).toEqual([{ type: 'tags', tags: ['pages', 'pages:1'], render: ['/kept'], prune: [] }])
    expect(res.queued).toBe(true)
    expect(res.routes).toEqual(['/kept'])
  })

  it('prunes the abandoned old URL when a rename is published (the save deliberately left it live)', async () => {
    insert(1, '/kept', 'published')
    const deps = new DepsStore()
    deps.record('/old-name', ['pages', 'pages:1']) // published under the previous slug
    deps.record('/listing', ['pages']) // a listing page — tagged, but still live: never pruned
    live.routes = ['/', '/kept', '/listing']
    setPublishRuntime({ queue: { enqueue: (inv) => enqueued.push(inv) }, deps })
    const res = await post({ collection: 'pages', ids: [1] })
    expect((enqueued[0] as { prune: string[] }).prune).toEqual(['/old-name'])
    expect(res.pruned).toEqual(['/old-name'])
  })

  it('prunes nothing when the live route set could not be enumerated in full', async () => {
    insert(1, '/kept', 'published')
    const deps = new DepsStore()
    deps.record('/old-name', ['pages:1'])
    live.failed = ['posts']
    setPublishRuntime({ queue: { enqueue: (inv) => enqueued.push(inv) }, deps })
    const res = await post({ collection: 'pages', ids: [1] })
    expect(res.pruned).toEqual([])
    expect((enqueued[0] as { prune: string[] }).prune).toEqual([])
  })

  it('reports a draft instead of publishing it — a draft has no public output to write', async () => {
    insert(2, '/draft', 'draft')
    const res = await post({ collection: 'pages', ids: [2] })
    expect(res.drafts).toEqual([2])
    expect(res.routes).toEqual([])
    expect(enqueued).toEqual([])
  })

  it('publishes several records in one call', async () => {
    insert(1, '/kept', 'published')
    insert(3, '/three', 'published')
    const res = await post({ collection: 'pages', ids: [1, 3] })
    expect(res.routes).toEqual(['/kept', '/three'])
    expect(enqueued).toHaveLength(2)
  })

  it('accepts a single `id` as well as an `ids` list', async () => {
    insert(1, '/kept', 'published')
    const res = await post({ collection: 'pages', id: 1 })
    expect(res.routes).toEqual(['/kept'])
  })

  it('404s an unknown collection and an id that is not in it — never a partial publish', async () => {
    insert(1, '/kept', 'published')
    expect(await statusOf(() => post({ collection: 'nope', ids: [1] }))).toBe(404)
    expect(await statusOf(() => post({ collection: 'pages', ids: [1, 99] }))).toBe(404)
    expect(enqueued).toEqual([])
  })

  it('400s a request with no ids', async () => {
    expect(await statusOf(() => post({ collection: 'pages', ids: [] }))).toBe(400)
  })

  it('401s a non-admin caller (the write-authorization backstop)', async () => {
    insert(1, '/kept', 'published')
    body = { collection: 'pages', ids: [1] }
    await expect(handler({ context: {} })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('reports that nothing is generated here instead of pretending, when the publisher is off', async () => {
    insert(1, '/kept', 'published')
    auto = false
    setPublishRuntime(null)
    const res = await post({ collection: 'pages', ids: [1] })
    expect(res.generates).toBe(false)
    expect(res.queued).toBe(false)
  })
})
