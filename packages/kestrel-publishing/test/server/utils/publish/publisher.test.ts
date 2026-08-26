import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { clearRegistry, getResolvedKestrelConfig, registerCollection, resetDbInstance, setResolvedKestrelConfig, useDb, type BuiltCollection, type StorageDriver } from '@michaelthielemann/kestrel-core'
import { DepsStore } from '../../../../src/server/utils/publish/deps.js'
import { currentSnapshot, type SnapshotsDb } from '../../../../src/server/db/snapshots.js'
import { setRenderRouteLive } from '../../../../src/server/utils/publish/render-seam.js'

// The publisher renders through the in-process Nitro app; the tests only need a 200 with a body. In the
// real app, the layer's `render-live.ts` wires this seam at module load (see its own comment) — this
// package test has no layer to import, so it wires the same shape directly, mirroring exactly what
// render-live.ts's own `renderRouteLive` does against the (also mocked) `nitropack/runtime`.
vi.mock('nitropack/runtime', () => ({
  useNitroApp: () => ({ localFetch: async () => new Response('<html>x</html>', { status: 200 }) }),
}))
// `nitropack/runtime`'s .d.ts re-export doesn't resolve under this package's NodeNext typecheck (the
// layer that normally imports it carries Nuxt-generated types this package tsconfig doesn't have) — cast
// at the crossing to the shape the mock above actually provides.
type NitroRuntime = { useNitroApp: () => { localFetch: (route: string, init: { method: string }) => Promise<Response> } }
setRenderRouteLive(async (route) => {
  const { useNitroApp } = await import('nitropack/runtime') as unknown as NitroRuntime
  const res = await useNitroApp().localFetch(route, { method: 'GET' })
  if (res.status !== 200) return { body: null, status: res.status }
  return { body: Buffer.from(await res.arrayBuffer()), status: res.status }
})

// clearVariants/saveDiscoveredVariants are explicit @michaelthielemann/kestrel-media imports in publisher.ts —
// saveDiscovered is assigned fresh in beforeEach, referenced lazily here so this
// factory (evaluated once, at import time) always calls whichever fn the current test set up.
vi.mock('@michaelthielemann/kestrel-media', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearVariants: () => {},
  saveDiscoveredVariants: (...args: unknown[]) => saveDiscovered(...args),
}))

const { allPublishedRoutes, publishFull, publishInvalidation } = await import('../../../../src/server/utils/publish/publisher.js')

// Drizzle tables whose columns match a `pageLike` collection: `pages` matches its SQL table, `posts`
// declares a `status` column the SQL table does not have (a drifted / unmigrated deploy) so its SELECT throws.
const pagesTable = sqliteTable('pages', { id: integer('id').primaryKey(), path: text('path'), status: text('status'), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }) })
const postsTable = sqliteTable('posts', { id: integer('id').primaryKey(), path: text('path'), status: text('status') })

const pages = { name: 'pages', def: { name: 'pages', pageLike: true, status: true }, table: pagesTable } as unknown as BuiltCollection
const posts = { name: 'posts', def: { name: 'posts', pageLike: true, status: true }, table: postsTable } as unknown as BuiltCollection

// A translatable collection: `locale` is a real column, and `allPublishedRoutes` resolves each route's
// locale from it — `pages`/`posts` above are non-translatable and always resolve to `null`.
const i18nTable = sqliteTable('i18n_pages', { id: integer('id').primaryKey(), path: text('path'), status: text('status'), locale: text('locale'), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }) })
const i18nPages = { name: 'i18n_pages', def: { name: 'i18n_pages', pageLike: true, status: true, translatable: true }, table: i18nTable } as unknown as BuiltCollection

let sqlite: Database.Database
let db: BetterSQLite3Database
let saveDiscovered: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let driver: ReturnType<typeof fakeDriver>

/** `allCollections` is an explicit `@michaelthielemann/kestrel-core` import in `publisher.ts` now (real registry), not a
 *  stubbable auto-import — route each test's fixture set through the real registry instead. */
function setCollections(list: BuiltCollection[]): void {
  clearRegistry()
  for (const c of list) registerCollection(c)
}

function asSnapshotsDb(db: BetterSQLite3Database): SnapshotsDb {
  return db as unknown as SnapshotsDb
}

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

/** publisher.ts's `outputConfig()` reads the config-provider seam, not `useRuntimeConfig()` (a package
 *  cannot reach the latter — see that function's own TSDoc) — this pushes `output` there instead of
 *  relying on a globalThis mock. */
function setOutput(output: Record<string, unknown>): void {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), output: output as never })
}

beforeEach(() => {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:', primaryLocale: 'en', prefixPrimary: false })
  resetDbInstance()
  db = useDb() as unknown as BetterSQLite3Database
  sqlite = (db as unknown as { $client: Database.Database }).$client
  sqlite.exec('CREATE TABLE pages (id INTEGER PRIMARY KEY, path TEXT, status TEXT, updated_at INTEGER)')
  sqlite.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, path TEXT)') // drifted: no `status` column
  sqlite.exec('CREATE TABLE publish_status (route TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, error TEXT, target TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  sqlite.exec('CREATE TABLE published_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, published_at INTEGER NOT NULL, superseded_by INTEGER, retracted_at INTEGER)')
  sqlite.exec('CREATE UNIQUE INDEX published_snapshots_route_current_unique ON published_snapshots (route) WHERE superseded_by IS NULL')
  sqlite.exec("INSERT INTO pages (id, path, status) VALUES (1, '/a', 'published')")
  sqlite.exec("INSERT INTO posts (id, path) VALUES (1, '/b')")
  setCollections([pages, posts])
  saveDiscovered = vi.fn()
  driver = fakeDriver()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  setOutput({ driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: false, reconcileMinutes: 0, verbose: false, s3: {} })
  Object.assign(globalThis, {
    publicReadableResources: () => ['pages', 'posts'],
    isPubliclyReadable: () => true,
  })
})

afterEach(() => { vi.restoreAllMocks() })

describe('allPublishedRoutes', () => {
  it('enumerates every published page-like route plus the site root', () => {
    setCollections([pages])
    const { routes, failed } = allPublishedRoutes()
    expect({ routes, failed }).toEqual({ routes: ['/', '/a'], failed: [] })
  })

  it('carries each route\'s last-saved stamp, so a full publish can tell published content from newer edits', () => {
    setCollections([pages])
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

describe('publishFull — records a snapshot per rendered route', () => {
  it('a successfully rendered route has a current snapshot readable through the store after publish', async () => {
    setCollections([pages])
    await publishFull(driver, new DepsStore())
    expect(currentSnapshot(asSnapshotsDb(db), '/a')).toMatchObject({ route: '/a', html: '<html>x</html>' })
  })

  it('never writes a snapshot for a route that failed to enumerate or render', async () => {
    // `posts` is drifted (no `status` column) — its route never renders, so no snapshot for `/b`.
    await publishFull(driver, new DepsStore())
    expect(currentSnapshot(asSnapshotsDb(db), '/b')).toBeNull()
  })

  it('threads the route\'s real locale into the recorded snapshot (a translatable collection)', async () => {
    sqlite.exec('CREATE TABLE i18n_pages (id INTEGER PRIMARY KEY, path TEXT, status TEXT, locale TEXT, updated_at INTEGER)')
    sqlite.exec("INSERT INTO i18n_pages (id, path, status, locale) VALUES (1, '/c', 'published', 'de')")
    setCollections([i18nPages])

    await publishFull(driver, new DepsStore())

    expect(currentSnapshot(asSnapshotsDb(db), '/de/c')).toMatchObject({ route: '/de/c', locale: 'de' })
  })

  it('threads the real locale through publishInvalidation\'s tag-scoped incremental path too', async () => {
    sqlite.exec('CREATE TABLE i18n_pages (id INTEGER PRIMARY KEY, path TEXT, status TEXT, locale TEXT, updated_at INTEGER)')
    sqlite.exec("INSERT INTO i18n_pages (id, path, status, locale) VALUES (1, '/c', 'published', 'de')")
    setCollections([i18nPages])

    await publishInvalidation({ type: 'tags', tags: [], render: ['/de/c'], prune: [] }, driver, new DepsStore())

    expect(currentSnapshot(asSnapshotsDb(db), '/de/c')).toMatchObject({ route: '/de/c', locale: 'de' })
  })
})

describe('publishFull — prune safety on an incomplete enumeration', () => {
  it('prunes tracked routes that left the published set when every collection was enumerated', async () => {
    setCollections([pages])
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
    setCollections([pages])
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
    setCollections([pages])
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

  it('holds nothing back with output.publishOnSave — that mode never defers a publish in the first place', async () => {
    sqlite.exec('UPDATE pages SET updated_at = 9000 WHERE id = 1')
    publishedAt('/a', 2)
    setOutput({ driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: false, publishOnSave: true, reconcileMinutes: 0, verbose: false, s3: {} })
    await publishFull(driver, new DepsStore())
    expect(driver.written).toContain('a/index.html')
  })

  // A rename moves the route STRING, so the record's new route has no publish_status row and the
  // never-published carve-out waves it through — while the old route, still the live one, looks abandoned
  // to the prune. The carve-out is about a first deploy having nothing to protect; a rename has plenty.
  it('holds back a renamed route whose record still has a live file at its old route', async () => {
    setCollections([pages])
    sqlite.exec("UPDATE pages SET path = '/new', updated_at = 9000 WHERE id = 1")
    publishedAt('/old', 2)
    const deps = new DepsStore()
    deps.record('/old', ['pages', 'pages:1'])
    await publishFull(driver, deps)
    expect(driver.written).not.toContain('new/index.html')
    expect(driver.deleted).not.toContain('old/index.html')
    expect(deps.routes()).toContain('/old')
  })

  it('publishes the rename once it is no longer pending — the old route is then genuinely abandoned', async () => {
    setCollections([pages])
    sqlite.exec("UPDATE pages SET path = '/new', updated_at = 1000 WHERE id = 1")
    publishedAt('/old', 20) // published AFTER the last save → the rename was published, /old is stale
    const deps = new DepsStore()
    deps.record('/old', ['pages', 'pages:1'])
    await publishFull(driver, deps)
    expect(driver.written).toContain('new/index.html')
    expect(driver.deleted).toContain('old/index.html')
  })

  it('does not narrow the variant registry when a route was skipped (its live file still uses those variants)', async () => {
    sqlite.exec('UPDATE pages SET updated_at = 9000 WHERE id = 1')
    publishedAt('/a', 2)
    await publishFull(driver, new DepsStore())
    expect(saveDiscovered).not.toHaveBeenCalled()
  })
})

// The hold-back is not a property of the FULL publish, it is a property of the route: a route with
// unpublished changes serves its last published file until someone publishes it. An incremental publish
// re-renders every tag-matched route from the live DB, so without the same filter, publishing one record
// writes an unrelated record's withheld body to the live site — the split, undone by a routine click.
describe('publishInvalidation — a tag-matched route with unpublished changes stays at its published version', () => {
  const publishedAt = (route: string, seconds: number) =>
    sqlite.exec(`INSERT INTO publish_status (route, status, target, updated_at) VALUES ('${route}', 'success', 'local', ${seconds})`)

  // `/a` (id 1) was published at t=2s and edited at t=9s → withheld. `/b` (id 2) is current. Both carry
  // the `pages` tag, as every page that lists the collection or reads the `site` singleton does.
  const withheldA = () => {
    setCollections([pages])
    sqlite.exec('UPDATE pages SET updated_at = 9000 WHERE id = 1')
    sqlite.exec("INSERT INTO pages (id, path, status, updated_at) VALUES (2, '/b', 'published', 1000)")
    publishedAt('/a', 2)
    publishedAt('/b', 20)
    const deps = new DepsStore()
    deps.record('/a', ['pages', 'pages:1'])
    deps.record('/b', ['pages', 'pages:2'])
    return deps
  }

  it('does not write a withheld referrer when another record is published', async () => {
    const deps = withheldA()
    await publishInvalidation({ type: 'tags', tags: ['pages', 'pages:2'], render: ['/b'], prune: [] }, driver, deps)
    expect(driver.written).not.toContain('a/index.html')
    expect(driver.written).toContain('b/index.html')
  })

  it('still writes the route the publish was actually FOR — pressing Publish is what clears it', async () => {
    const deps = withheldA()
    await publishInvalidation({ type: 'tags', tags: ['pages', 'pages:1'], render: ['/a'], prune: [] }, driver, deps)
    expect(driver.written).toContain('a/index.html')
  })

  it('holds nothing back with output.publishOnSave — that mode never defers a publish', async () => {
    const deps = withheldA()
    setOutput({ driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: false, publishOnSave: true, reconcileMinutes: 0, verbose: false, s3: {} })
    await publishInvalidation({ type: 'tags', tags: ['pages', 'pages:2'], render: ['/b'], prune: [] }, driver, deps)
    expect(driver.written).toContain('a/index.html')
  })

  // Withholding governs what is WRITTEN, never what is removed: a route whose record was unpublished or
  // deleted has no publish intent left to protect, and ADR-0008 keeps removal immediate on purpose.
  it('still prunes a withheld route that is being removed', async () => {
    const deps = withheldA()
    await publishInvalidation({ type: 'tags', tags: ['pages', 'pages:1'], render: [], prune: ['/a'] }, driver, deps)
    expect(driver.deleted).toContain('a/index.html')
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
    setOutput({ driver: 'local', dir: '', publicDir, auto: false, reconcileMinutes: 0, verbose: false, s3: {} })
  })

  afterEach(() => { rmSync(publicDir, { recursive: true, force: true }) })

  it('does not upload a build-time HTML/sitemap precompressed sidecar as a stale content-negotiable file', async () => {
    setCollections([pages])
    await publishFull(driver, new DepsStore())
    expect(driver.written).not.toContain('index.html.br')
    expect(driver.written).not.toContain('sitemap.xml.gz')
    expect(driver.written).toContain('app.js.br') // a real asset sidecar is still synced
  })

  it('keeps a standalone archive typed as an archive — no Content-Encoding means no suffix strip', async () => {
    setCollections([pages])
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
    setCollections([pages])
    await publishFull(driver, new DepsStore())
    const messages = consoleErrorSpy.mock.calls.map((args: unknown[]) => String(args[0]))
    expect(messages.some((m: string) => m.includes('publicDir') && m.includes('/kestrel-no-such-public-dir'))).toBe(true)
  })
})

describe('publishFull — overlapping callers', () => {
  it('runs a caller that arrives mid-publish on its own, instead of folding it into the run in progress', async () => {
    // The `publish:run` task and the auto-publish queue can overlap, each with its own output driver and
    // its own durable deps. Folding the later caller into the running pass would hand it that pass's
    // already-taken route snapshot — an edit made after the snapshot never renders, and the folded
    // caller's deps stay empty, so it can never prune either.
    setCollections([pages])
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
