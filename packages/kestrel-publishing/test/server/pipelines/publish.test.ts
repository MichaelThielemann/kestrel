import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clearPipelines, clearRegistry, defineCollection, desiredSchema, diffSchema, getResolvedKestrelConfig, registerCollection, registerPipeline, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb, buildCollection } from '@kestrel/core'
import { callPipelineRoute, usePipelineRouteDb } from '../../../../../test/helpers/pipeline-route.js'
import { DepsStore, setPublishRuntime, type Invalidation } from '@kestrel/publishing'
import { buildPublishPipelines } from '../../../src/server/pipelines/publish.js'

// The pipeline asks the publisher which routes are live (to spot a record's abandoned old URL); the real
// module reaches for the storage drivers and the built output, none of which a node test has. Mocked by
// RESOLVED path (not the `@kestrel/publishing` barrel) so it intercepts the SAME module `publish.ts`'s own
// relative `../utils/publish/publisher.js` import resolves to.
const live = { routes: ['/', '/kept'], savedAt: new Map<string, number>(), failed: [] as string[] }
vi.mock('../../../src/server/utils/publish/publisher.js', () => ({ allPublishedRoutes: () => live }))

let db: BetterSQLite3Database

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true, fields: { title: { type: 'text' } },
}))

let sqlite: Database.Database
let enqueued: Invalidation[]
let auto: boolean
let publishOnSave: boolean

Object.assign(globalThis, {
  public: { locales: ['en'], primaryLocale: 'en', prefixPrimary: false },
})

/** `pipelines/publish.ts`'s own `outputConfig()` reads the config-provider seam, not `useRuntimeConfig()`
 *  (a package cannot reach the latter) — pushes the CURRENT `auto`/`publishOnSave` there. Called in
 *  `beforeEach` and again wherever a test reassigns either mid-test (the seam is a snapshot, not a live
 *  binding the way the old `useRuntimeConfig` mock closure was). */
function pushOutput(): void {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), output: { driver: 'local', auto, publishOnSave } as never })
}

const post = (body: Record<string, unknown>, role = 'admin') =>
  callPipelineRoute('POST', '/api/publish', { role, body }) as Promise<Record<string, unknown>>
const status = (id: number, collection = 'pages') =>
  callPipelineRoute('GET', `/api/publishStatus?collection=${collection}&id=${id}`, { role: 'admin' }) as Promise<Record<string, unknown>>

function insert(id: number, path: string, recordStatus: string, savedAt = 0): void {
  sqlite.prepare('INSERT INTO pages (id, path, status, title, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, path, recordStatus, `T${id}`, savedAt)
}

/** `savedAt` in ms (the record's own stamp), `publishedAt` in whole seconds (publish_status's own unit). */
function seed(id: number, savedAt: number, publishedAt?: number): void {
  insert(id, `/p${id}`, 'published', savedAt)
  if (publishedAt !== undefined) {
    sqlite.prepare("INSERT INTO publish_status (route, status, target, updated_at) VALUES (?, 'success', 'local', ?)")
      .run(`/p${id}`, publishedAt)
  }
}

beforeEach(() => {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  db = useDb() as unknown as BetterSQLite3Database
  usePipelineRouteDb(db)
  sqlite = (db as unknown as { $client: Database.Database }).$client
  const desired = desiredSchema([pages.table], new Map([['pages', pages.def]]) as never)
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  sqlite.exec('CREATE TABLE publish_status (route TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, error TEXT, target TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  clearRegistry()
  clearPipelines()
  registerCollection(pages)
  for (const def of buildPublishPipelines()) registerPipeline(def)
  enqueued = []
  auto = true
  publishOnSave = false
  pushOutput()
  live.routes = ['/', '/kept']
  live.failed = []
  setPublishRuntime({ queue: { enqueue: (inv) => enqueued.push(inv) }, deps: new DepsStore() })
})
afterEach(() => { clearRegistry(); clearPipelines(); setPublishRuntime(null) })

describe('POST /api/publish — the explicit "write the static file" action', () => {
  it('enqueues the record\'s own route plus the pages that embed it', async () => {
    insert(1, '/kept', 'published')
    const res = await post({ collection: 'pages', ids: [1] })
    expect(enqueued).toEqual([{ type: 'tags', tags: ['pages', 'pages:1', '#path:/kept'], render: ['/kept'], prune: [] }])
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
    await expect(post({ collection: 'nope', ids: [1] })).rejects.toMatchObject({ statusCode: 404 })
    await expect(post({ collection: 'pages', ids: [1, 99] })).rejects.toMatchObject({ statusCode: 404 })
    expect(enqueued).toEqual([])
  })

  it('400s a request with no ids', async () => {
    await expect(post({ collection: 'pages', ids: [] })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('401s a non-admin caller', async () => {
    insert(1, '/kept', 'published')
    await expect(post({ collection: 'pages', ids: [1] }, 'anonymous')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('401s a renderer principal — read-only role, not merely "some principal present"', async () => {
    insert(1, '/kept', 'published')
    await expect(post({ collection: 'pages', ids: [1] }, 'renderer')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('reports that nothing is generated here instead of pretending, when the publisher is off', async () => {
    insert(1, '/kept', 'published')
    auto = false
    pushOutput()
    setPublishRuntime(null)
    const res = await post({ collection: 'pages', ids: [1] })
    expect(res.generates).toBe(false)
    expect(res.queued).toBe(false)
  })

  // isDevMode() is fail-safe-to-PRODUCTION (adopts @kestrel/auth's session.ts own `explicitDev` polarity):
  // an omitted NODE_ENV (a common slip when launching `.output/server/index.mjs`) must read as production,
  // never silently downgrade to "nothing generates here". Vitest itself sets NODE_ENV='test' (an explicit
  // dev signal by design — every OTHER test in this file relies on that), so this one test deliberately
  // deletes it to pin the omitted case, then restores it.
  it('treats an OMITTED NODE_ENV as production, not dev — generates stays true, not silently false', async () => {
    insert(1, '/kept', 'published')
    const savedNodeEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      const res = await post({ collection: 'pages', ids: [1] })
      expect(res.generates).toBe(true)
    } finally {
      process.env.NODE_ENV = savedNodeEnv
    }
  })

  it('is a write pipeline: a GET on the same URL is refused', async () => {
    await expect(callPipelineRoute('GET', '/api/publish', { role: 'admin' })).rejects.toMatchObject({ statusCode: 405 })
  })
})

describe('GET /api/publishStatus — unpublished changes', () => {
  it('flags a record that was saved after its page was last published', async () => {
    seed(1, 60_000, 10) // saved at 60s, published at 10s
    await expect(status(1)).resolves.toMatchObject({ route: '/p1', status: 'success', pending: true })
  })

  it('does not flag a page whose publish is current', async () => {
    seed(2, 10_000, 60)
    await expect(status(2)).resolves.toMatchObject({ pending: false })
  })

  it('does not flag a page that was never published (nothing to fall behind)', async () => {
    seed(3, 10_000)
    await expect(status(3)).resolves.toMatchObject({ route: '/p3', status: null, pending: false })
  })

  // With `output.publishOnSave` a save republishes on its own, so "saved since the last publish" is a
  // republish in flight — the lamp must keep showing that, not an "Outdated" the user cannot act on.
  it('never flags unpublished changes when the consumer opted out of the split', async () => {
    publishOnSave = true
    pushOutput()
    seed(4, 60_000, 10)
    await expect(status(4)).resolves.toMatchObject({ pending: false, publishOnSave: true })
  })
})

// With publishing deferred to an explicit action, "no status row" and "a publish is in flight" are
// opposites: nothing is running, and nothing will, until someone presses Publish. The lamp needs to
// tell them apart.
describe('GET /api/publishStatus — never published', () => {
  it('reports a routable page with no publish row as never published', async () => {
    seed(1, 10_000)
    await expect(status(1)).resolves.toMatchObject({ route: '/p1', status: null, neverPublished: true })
  })

  it('is not "never published" once the page has a publish row', async () => {
    seed(2, 10_000, 60)
    await expect(status(2)).resolves.toMatchObject({ neverPublished: false })
  })

  it('is not "never published" for a record with no public route at all', async () => {
    await expect(status(99)).resolves.toMatchObject({ route: null, neverPublished: false })
  })

  it('401s an anonymous caller — the lamp is admin-only', async () => {
    seed(1, 10_000)
    await expect(callPipelineRoute('GET', '/api/publishStatus?collection=pages&id=1', { role: 'anonymous' }))
      .rejects.toMatchObject({ statusCode: 401 })
  })
})
