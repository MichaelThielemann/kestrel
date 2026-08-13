import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import type { StorageDriver } from '../../../../core/server/utils/storage'
import { DepsStore } from './deps'

// The publisher renders through the in-process Nitro app; the tests only need a 200 with a body.
vi.mock('nitropack/runtime', () => ({
  useNitroApp: () => ({ localFetch: async () => new Response('<html>x</html>', { status: 200 }) }),
}))

const { allPublishedRoutes, publishFull } = await import('./publisher')

// Drizzle tables whose columns match a `pageLike` collection: `pages` matches its SQL table, `posts`
// declares a `status` column the SQL table does not have (a drifted / unmigrated deploy) so its SELECT throws.
const pagesTable = sqliteTable('pages', { id: integer('id').primaryKey(), path: text('path'), status: text('status'), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }) })
const postsTable = sqliteTable('posts', { id: integer('id').primaryKey(), path: text('path'), status: text('status') })

const pages = { def: { name: 'pages', pageLike: true, status: true }, table: pagesTable }
const posts = { def: { name: 'posts', pageLike: true, status: true }, table: postsTable }

let sqlite: Database.Database
let db: BetterSQLite3Database
let collections: unknown[]
let saveDiscovered: ReturnType<typeof vi.fn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let driver: ReturnType<typeof fakeDriver>

function fakeDriver() {
  const deleted: string[] = []
  const written: string[] = []
  const puts: Array<{ key: string; contentType: string; contentEncoding?: string }> = []
  return {
    deleted,
    written,
    puts,
    async put(key: string, _bytes: Buffer, contentType: string, opts?: { contentEncoding?: string }) {
      written.push(key)
      puts.push({ key, contentType, contentEncoding: opts?.contentEncoding })
    },
    async copy() {},
    async delete(key: string) { deleted.push(key) },
    publicUrl: (key: string) => `/${key}`,
  } as StorageDriver & { deleted: string[]; written: string[]; puts: Array<{ key: string; contentType: string; contentEncoding?: string }> }
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE pages (id INTEGER PRIMARY KEY, path TEXT, status TEXT, updated_at INTEGER)')
  sqlite.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, path TEXT)') // drifted: no `status` column
  sqlite.exec('CREATE TABLE publish_status (route TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, error TEXT, target TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  sqlite.exec("INSERT INTO pages (id, path, status) VALUES (1, '/a', 'published')")
  sqlite.exec("INSERT INTO posts (id, path) VALUES (1, '/b')")
  db = drizzle(sqlite)
  collections = [pages, posts]
  saveDiscovered = vi.fn()
  driver = fakeDriver()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.assign(globalThis, {
    useDb: () => db,
    useRuntimeConfig: () => ({ kestrel: { output: { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: false, reconcileMinutes: 0, verbose: false, s3: {} } } }),
    primaryLocale: () => 'en',
    prefixPrimaryLocale: () => false,
    publicReadableResources: () => ['pages', 'posts'],
    isPubliclyReadable: () => true,
    allCollections: () => collections,
    clearVariants: () => {},
    saveDiscoveredVariants: (...args: unknown[]) => saveDiscovered(...args),
  })
})

afterEach(() => { vi.restoreAllMocks() })

describe('allPublishedRoutes', () => {
  it('enumerates every published page-like route plus the site root', () => {
    collections = [pages]
    const { routes, failed } = allPublishedRoutes()
    expect({ routes, failed }).toEqual({ routes: ['/', '/a'], failed: [] })
  })

  it('carries each route\'s last-saved stamp, so a full publish can tell published content from newer edits', () => {
    collections = [pages]
    sqlite.exec('UPDATE pages SET updated_at = 5000 WHERE id = 1')
    expect(allPublishedRoutes().savedAt.get('/a')).toBe(5000)
  })

  it('reports the collections whose query failed instead of silently dropping their routes', () => {
    // `posts` drifted (no `status` column) → its SELECT throws. The enumeration is INCOMPLETE, and the
    // caller must be able to see that — an empty contribution is indistinguishable from "no posts".
    const result = allPublishedRoutes()
    expect(result.routes).toEqual(['/', '/a'])
    expect(result.failed).toEqual(['posts'])
  })
})

describe('publishFull — prune safety on an incomplete enumeration', () => {
  it('prunes tracked routes that left the published set when every collection was enumerated', async () => {
    collections = [pages]
    const deps = new DepsStore()
    deps.record('/gone', ['pages'])
    const result = await publishFull(driver, deps)
    expect(driver.deleted).toEqual(['gone/index.html'])
    expect(deps.routes()).not.toContain('/gone')
    expect(result.pruned).toBe(1)
  })

  it('prunes nothing when a collection could not be enumerated (an incomplete read must not shrink the live site)', async () => {
    const deps = new DepsStore()
    deps.record('/b', ['posts']) // a posts page, live and tracked — invisible to the failed query
    deps.record('/a', ['pages'])
    const result = await publishFull(driver, deps)
    expect(driver.deleted).toEqual([])
    expect(deps.routes()).toContain('/b')
    expect(result.pruned).toBe(0)
  })

  it('does not narrow the variant registry when a collection could not be enumerated', async () => {
    // Every enumerated route rendered, but the un-enumerated collection's routes were never visited, so the
    // discovery accumulator is incomplete — reconciling it would deregister variants the live pages still use.
    await publishFull(driver, new DepsStore())
    expect(saveDiscovered).not.toHaveBeenCalled()
  })

  it('narrows the variant registry when the enumeration and every render succeeded', async () => {
    collections = [pages]
    await publishFull(driver, new DepsStore())
    expect(saveDiscovered).toHaveBeenCalled()
  })
})

// A full publish (boot / reconciler) resynchronizes the output with the DB — which, with publishing
// deferred to an explicit action, would push every saved-but-unpublished edit live behind the editor's
// back. Those routes keep the file they were last published with instead.
describe('publishFull — saved-but-unpublished edits stay unpublished', () => {
  const publishedAt = (route: string, seconds: number) =>
    sqlite.exec(`INSERT INTO publish_status (route, status, target, updated_at) VALUES ('${route}', 'success', 'local', ${seconds})`)

  beforeEach(() => {
    collections = [pages]
    sqlite.exec("INSERT INTO pages (id, path, status, updated_at) VALUES (2, '/b', 'published', 9000)")
  })

  it('skips a route whose record was saved after its last publish', async () => {
    sqlite.exec('UPDATE pages SET updated_at = 9000 WHERE id = 1')
    publishedAt('/a', 2) // /a published at t=2s, saved again at t=9s → pending
    publishedAt('/b', 20) // /b published after its last save → still current
    const result = await publishFull(driver, new DepsStore())
    expect(driver.written).not.toContain('a/index.html')
    expect(driver.written).toContain('b/index.html')
    expect(result.rendered).toBe(2) // `/` and `/b`
  })

  it('never prunes a skipped route — its published file is what the site is still serving', async () => {
    sqlite.exec('UPDATE pages SET updated_at = 9000 WHERE id = 1')
    publishedAt('/a', 2)
    const deps = new DepsStore()
    deps.record('/a', ['pages'])
    await publishFull(driver, deps)
    expect(driver.deleted).toEqual([])
    expect(deps.routes()).toContain('/a')
  })

  it('still renders a published route that was never published to a file (a first deploy has nothing to protect)', async () => {
    sqlite.exec('UPDATE pages SET updated_at = 9000 WHERE id = 1')
    const result = await publishFull(driver, new DepsStore())
    expect(driver.written).toContain('a/index.html')
    expect(result.rendered).toBe(3)
  })

  it('does not narrow the variant registry when a route was skipped (its live file still uses those variants)', async () => {
    sqlite.exec('UPDATE pages SET updated_at = 9000 WHERE id = 1')
    publishedAt('/a', 2)
    await publishFull(driver, new DepsStore())
    expect(saveDiscovered).not.toHaveBeenCalled()
  })
})

describe('publishFull — syncStaticAssets skip filter', () => {
  let publicDir: string

  beforeEach(() => {
    publicDir = mkdtempSync(join(tmpdir(), 'kestrel-publish-assets-'))
    writeFileSync(join(publicDir, 'index.html'), '<html>stale build-time html</html>')
    writeFileSync(join(publicDir, 'index.html.br'), 'stale-brotli-bytes')
    writeFileSync(join(publicDir, 'sitemap.xml.gz'), 'stale-gzip-bytes')
    writeFileSync(join(publicDir, 'app.js'), 'console.log(1)')
    writeFileSync(join(publicDir, 'app.js.br'), 'brotli-bytes')
    writeFileSync(join(publicDir, 'catalog.json.gz'), 'standalone-gzip-bytes') // no uncompressed sibling
    Object.assign(globalThis, {
      useRuntimeConfig: () => ({ kestrel: { output: { driver: 'local', dir: '', publicDir, auto: false, reconcileMinutes: 0, verbose: false, s3: {} } } }),
    })
  })

  afterEach(() => { rmSync(publicDir, { recursive: true, force: true }) })

  it('does not upload a build-time HTML/sitemap precompressed sidecar as a stale content-negotiable file', async () => {
    collections = [pages]
    await publishFull(driver, new DepsStore())
    expect(driver.written).not.toContain('index.html.br')
    expect(driver.written).not.toContain('sitemap.xml.gz')
    expect(driver.written).toContain('app.js.br') // a real asset sidecar is still synced
  })

  it('keeps a standalone archive typed as an archive — no Content-Encoding means no suffix strip', async () => {
    collections = [pages]
    await publishFull(driver, new DepsStore())
    const standalone = driver.puts.find((p) => p.key === 'catalog.json.gz')!
    expect(standalone.contentEncoding).toBeUndefined()
    expect(standalone.contentType).not.toContain('application/json') // raw gzip bytes labelled JSON
    const sidecar = driver.puts.find((p) => p.key === 'app.js.br')!
    expect(sidecar.contentEncoding).toBe('br')
    expect(sidecar.contentType).toContain('text/javascript') // encoded sibling keeps the base type
  })
})

describe('publishFull — unreadable output.publicDir', () => {
  it('logs loudly instead of silently publishing HTML with no synced assets', async () => {
    // The test config already points publicDir at a non-existent directory (see beforeEach).
    collections = [pages]
    await publishFull(driver, new DepsStore())
    const messages = consoleErrorSpy.mock.calls.map((args) => String(args[0]))
    expect(messages.some((m) => m.includes('publicDir') && m.includes('/kestrel-no-such-public-dir'))).toBe(true)
  })
})

describe('publishFull — overlapping callers', () => {
  it('runs a caller that arrives mid-publish on its own, instead of folding it into the run in progress', async () => {
    // The `publish:run` task and the auto-publish queue can overlap, each with its own output driver and
    // its own durable deps. Folding the later caller into the running pass would hand it that pass's
    // already-taken route snapshot — an edit made after the snapshot never renders, and the folded
    // caller's deps stay empty, so it can never prune either.
    collections = [pages]
    const first = fakeDriver()
    const second = fakeDriver()
    const depsA = new DepsStore()
    const depsB = new DepsStore()
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const midRun = new Promise<void>((r) => { reached = r })
    const realPut = first.put.bind(first)
    let parked = false
    // Park the first run inside its very first write — it stays in flight, doing nothing, while the
    // second caller arrives and completes. (Renders are serialized on purpose: two simultaneous ones
    // race inside vitest's loader over the mocked `nitropack/runtime`, which is not what this pins.)
    first.put = async (key, bytes, contentType, opts) => {
      if (!parked) { parked = true; reached(); await gate }
      return realPut(key, bytes, contentType, opts)
    }
    const runA = publishFull(first, depsA)
    await midRun
    // No wall-clock wait: the second caller has to settle entirely on its own while the first is still
    // parked. Folding would make this await the parked run instead, which never resolves until the
    // timeout — a hang, not a coin flip.
    try { await publishFull(second, depsB) } finally { release() }
    await runA
    expect(second.written).toContain('index.html')
    expect(second.written).toContain('llms.txt') // it ran to the end, not just up to the fold point
    expect(depsB.routes()).toContain('/a') // the second caller recorded its own deps
    expect(first.written).toContain('index.html')
  })
})
