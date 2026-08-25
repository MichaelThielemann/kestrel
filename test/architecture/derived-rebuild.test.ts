import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import sharp from 'sharp'
import { sql, eq, getTableColumns } from 'drizzle-orm'
import { createTestDb } from '../helpers/db'
import { DEFAULT_IMAGE_POLICY, clearOutboxHandlers, clearPipelines, clearRegistry, create, createLocalDriver, ensureRevisionsTable, findReferrers, getResolvedKestrelConfig, pollOnce, rebuildRecordRefs, recordRefs, registerCollection, registerReindexRefs, resetDbInstance, setResolvedKestrelConfig, sqliteClientOf, useContentDbFor, useDb } from '@kestrel/core'
import type { BuiltCollection, StorageDriver } from '@kestrel/core'
import { richtextLinkHref } from '@kestrel/core/client'
import { pagesCollection } from '@kestrel/collections'
import postsCollection from '../../server/collections/posts'
import { DepsStore, publishDeps } from '@kestrel/publishing'
import { runBackfill, media } from '@kestrel/media'

// Per-route data tags the mocked render below should report as "read" — set by the publish_deps block so
// its renders produce non-trivial deps captures (the other blocks leave this empty: no tags captured).
const routeTags = vi.hoisted(() => ({ current: new Map<string, string[]>() }))

const migrationsFolder = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'server/database/migrations')

// The publisher renders through the in-process Nitro app; a node test has no running server, so this
// stub is the transport, not the rebuild logic under test. Content is a deterministic function of the
// route, so a rebuild's bytes are directly comparable to the original build's. Hoisted to module scope —
// vi.mock must not live inside a describe block. `captureRead` is imported dynamically (not at module top)
// because a `vi.mock` factory runs before the file's own imports are hoisted.
vi.mock('nitropack/runtime', () => ({
  useNitroApp: () => ({
    localFetch: async (route: string) => {
      const tags = routeTags.current.get(route)
      if (tags?.length) {
        const { captureRead } = await import('@kestrel/core')
        for (const tag of tags) {
          const [coll, id] = tag.split(':')
          captureRead(coll!, id ? Number(id) : undefined)
        }
      }
      return new Response(`<html>${route}</html>`, { status: 200 })
    },
  }),
}))
// Wires the real renderRouteLive into @kestrel/publishing's render seam (against the mocked
// nitropack/runtime above) — the same explicit setRenderRouteLive call zz.publish.ts/tasks/publish/run.ts
// make in production (not a module-load side effect — see either file's own comment for why). Both
// dynamically imported (not at module top) for the same reason nitropack is mocked above the file's own
// hoisted imports.
const { renderRouteLive } = await import('../../layers/public/server/utils/publish/render-live')
const { setRenderRouteLive } = await import('@kestrel/publishing')
setRenderRouteLive(renderRouteLive)

/**
 * CI proof for the "derived" module class (docs/internals/data-model.md): each block seeds real state,
 * destroys the derived artifact (the kill), runs the SAME rebuild entry point production/CI uses, and
 * asserts the derived state is reconstructed. No mocked rebuild logic — only the render/derive transport
 * (nitropack's localFetch) is stubbed, since a node test has no running Nuxt server.
 */

// --- record_refs: kill the index table, rebuild by replaying `maintainRecordRefs` over every live row
// (the same reindexRefs outbox handler every write's poll already drives) — the CI recovery procedure for
// a corrupted/lost index.
describe('derived: record_refs — reindex rebuild', () => {
  let db: BetterSQLite3Database
  beforeEach(() => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
    resetDbInstance()
    db = useDb() as unknown as BetterSQLite3Database
    migrate(db, { migrationsFolder })
    clearRegistry()
    registerCollection(pagesCollection)
    registerCollection(postsCollection)
    ensureRevisionsTable(sqliteClientOf(db), 'pages')
    ensureRevisionsTable(sqliteClientOf(db), 'posts')
    clearPipelines()
    clearOutboxHandlers()
    registerReindexRefs()
  })

  function edgesSnapshot(): string[] {
    return db.select().from(recordRefs).all()
      .map((r) => `${r.sourceColl}:${r.sourceId}->${r.targetColl}:${r.targetId}`)
      .sort()
  }

  it('reconstructs the index row-equal after the table is wiped', async () => {
    const target = create(db, pagesCollection, { title: 'Target', path: '/target', status: 'published' }) as Record<string, unknown>
    const targetId = target.id as number
    const body = `<p><a href="${richtextLinkHref('pages', targetId)}">see the page</a></p>`
    const referrer = create(db, postsCollection, { title: 'Referrer', body, status: 'published' }) as Record<string, unknown>
    const refId = referrer.id as number
    // Seed the "before" baseline via the path production actually runs: the write emits an outbox
    // event, the reindexRefs handler applies it on poll.
    await pollOnce(db, 'content')

    const contentDb = useContentDbFor(db).db

    const before = edgesSnapshot()
    expect(before.length).toBeGreaterThan(0) // sanity: the write path did populate the index
    expect(findReferrers(contentDb, 'pages', targetId)).toEqual([{ collection: 'posts', id: refId }])

    db.delete(recordRefs).run()
    expect(edgesSnapshot()).toEqual([])
    expect(findReferrers(contentDb, 'pages', targetId)).toEqual([]) // proves the kill: the reference is now invisible

    // The rebuild: the production entry point (`rebuildRecordRefs`), not a hand-composed replay.
    rebuildRecordRefs(contentDb)

    expect(edgesSnapshot()).toEqual(before)
    expect(findReferrers(contentDb, 'pages', targetId)).toEqual([{ collection: 'posts', id: refId }])
  })
})

// --- publish output + sitemap/robots/redirects: kill the static output directory, rebuild by calling the
// REAL `publishFull` (the same function the boot publish and the reconciler task call) against a real
// local StorageDriver (real filesystem, not a fake).
describe('derived: publish output (+ sitemap/robots/redirects) — publishFull rebuild', () => {
  let publishFull: typeof import('@kestrel/publishing').publishFull
  let sqlite: Database.Database
  let db: BetterSQLite3Database
  let dir: string
  let driver: StorageDriver & { list: () => Promise<string[]>; get: (key: string) => Promise<Buffer> }

  beforeEach(async () => {
    ;({ publishFull } = await import('@kestrel/publishing'))
    const output = { driver: 'local' as const, dir: '', publicDir: '/kestrel-no-such-public-dir', auto: false, publishOnSave: false, reconcileMinutes: 0, verbose: false, s3: { bucket: '', region: '', endpoint: '', prefix: '', accessKeyId: '', secretAccessKey: '', sessionToken: '' } }
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:', primaryLocale: 'en', prefixPrimary: false, supportedLocales: ['en'], output })
    resetDbInstance()
    db = useDb() as unknown as BetterSQLite3Database
    sqlite = (db as unknown as { $client: Database.Database }).$client
    sqlite.exec('CREATE TABLE pages (id INTEGER PRIMARY KEY, path TEXT, status TEXT, updated_at INTEGER)')
    sqlite.exec('CREATE TABLE publish_status (route TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, error TEXT, target TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    sqlite.exec('CREATE TABLE published_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, published_at INTEGER NOT NULL, superseded_by INTEGER, retracted_at INTEGER)')
    sqlite.exec('CREATE UNIQUE INDEX published_snapshots_route_current_unique ON published_snapshots (route) WHERE superseded_by IS NULL')
    sqlite.exec("INSERT INTO pages (id, path, status) VALUES (1, '/a', 'published'), (2, '/b', 'published')")
    dir = mkdtempSync(join(tmpdir(), 'kestrel-derived-rebuild-'))
    driver = createLocalDriver({ dir, baseUrl: '/x' }) as typeof driver
    const pagesSqlTable = sqliteTable('pages', { id: integer('id').primaryKey(), path: text('path'), status: text('status'), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }) })
    const pagesTable = { name: 'pages', def: { name: 'pages', pageLike: true, status: true }, table: pagesSqlTable }
    clearRegistry()
    registerCollection(pagesTable as unknown as BuiltCollection)
    Object.assign(globalThis, {
      useRuntimeConfig: () => ({ kestrel: { output: { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: false, reconcileMinutes: 0, verbose: false, s3: {} } } }),
      publicReadableResources: () => ['pages'],
      isPubliclyReadable: () => true,
      clearVariants: () => {},
      saveDiscoveredVariants: () => {},
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    clearRegistry()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reconstructs the full file set + byte-identical content after the output directory is wiped', async () => {
    await publishFull(driver, new DepsStore())
    const beforeKeys = (await driver.list()).sort()
    // Real pages + the crawler/agent artifacts (sitemap/robots/llms/redirects) must all have been written.
    expect(beforeKeys).toEqual(expect.arrayContaining(['a/index.html', 'b/index.html', 'index.html', 'sitemap.xml', 'robots.txt', 'redirects.json']))
    const beforeContent = new Map(await Promise.all(beforeKeys.map(async (k) => [k, await driver.get(k)] as const)))

    // The kill: the whole static output is gone (the on-disk analogue of a lost bucket/volume).
    rmSync(dir, { recursive: true, force: true })
    expect(await driver.list()).toEqual([])

    // The rebuild: the same full-publish entry point the boot publish / reconciler call.
    await publishFull(driver, new DepsStore())

    const afterKeys = (await driver.list()).sort()
    expect(afterKeys).toEqual(beforeKeys)
    for (const key of afterKeys) {
      expect((await driver.get(key)).equals(beforeContent.get(key)!)).toBe(true)
    }
  })
})

// --- publish_deps: kill the persisted `route -> tags` table, rebuild by calling the REAL `publishFull`
// against a `DepsStore` wired with the REAL `createSqlitePersistence` port — exactly as
// `layers/public/server/plugins/zz.publish.ts` constructs it at boot.
describe('derived: publish_deps (route -> tag index) — republish rebuild', () => {
  let publishFull: typeof import('@kestrel/publishing').publishFull
  let createSqlitePersistence: typeof import('@kestrel/publishing').createSqlitePersistence
  let sqlite: Database.Database
  let db: BetterSQLite3Database
  let dir: string
  let driver: StorageDriver

  beforeEach(async () => {
    ;({ publishFull, createSqlitePersistence } = await import('@kestrel/publishing'))
    const output = { driver: 'local' as const, dir: '', publicDir: '/kestrel-no-such-public-dir', auto: false, publishOnSave: false, reconcileMinutes: 0, verbose: false, s3: { bucket: '', region: '', endpoint: '', prefix: '', accessKeyId: '', secretAccessKey: '', sessionToken: '' } }
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:', primaryLocale: 'en', prefixPrimary: false, supportedLocales: ['en'], output })
    resetDbInstance()
    db = useDb() as unknown as BetterSQLite3Database
    sqlite = (db as unknown as { $client: Database.Database }).$client
    sqlite.exec('CREATE TABLE pages (id INTEGER PRIMARY KEY, path TEXT, status TEXT, updated_at INTEGER)')
    sqlite.exec('CREATE TABLE publish_status (route TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, error TEXT, target TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    sqlite.exec('CREATE TABLE published_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, published_at INTEGER NOT NULL, superseded_by INTEGER, retracted_at INTEGER)')
    sqlite.exec('CREATE UNIQUE INDEX published_snapshots_route_current_unique ON published_snapshots (route) WHERE superseded_by IS NULL')
    sqlite.exec('CREATE TABLE publish_deps (route TEXT PRIMARY KEY NOT NULL, tags TEXT NOT NULL)') // mirrors layers/public/server/database/publish-deps.ts
    sqlite.exec("INSERT INTO pages (id, path, status) VALUES (1, '/a', 'published'), (2, '/b', 'published')")
    dir = mkdtempSync(join(tmpdir(), 'kestrel-derived-deps-'))
    driver = createLocalDriver({ dir, baseUrl: '/x' })
    const pagesSqlTable = sqliteTable('pages', { id: integer('id').primaryKey(), path: text('path'), status: text('status'), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }) })
    const pagesTable = { name: 'pages', def: { name: 'pages', pageLike: true, status: true }, table: pagesSqlTable }
    clearRegistry()
    registerCollection(pagesTable as unknown as BuiltCollection)
    // What each route "reads" while rendering — a listing (root) tags the collection, a detail page tags
    // its own record. Simulates the real SSR read-capture the stubbed nitro transport can't produce itself.
    routeTags.current = new Map([['/', ['pages']], ['/a', ['pages:1']], ['/b', ['pages:2']]])
    Object.assign(globalThis, {
      useRuntimeConfig: () => ({ kestrel: { output: { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: false, reconcileMinutes: 0, verbose: false, s3: {} } } }),
      publicReadableResources: () => ['pages'],
      isPubliclyReadable: () => true,
      clearVariants: () => {},
      saveDiscoveredVariants: () => {},
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    clearRegistry()
    routeTags.current = new Map()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reconstructs the persisted deps index after the table is wiped', async () => {
    // `db` is the raw content-db singleton (`useDb()`), not the publishing adapter — deliberately, this
    // suite exercises the derived-rebuild story end to end, not the ownership adapter. `DepsPersistenceDb`
    // is branded, so the cast at this crossing is required (mirrors `record-ref-index.test.ts`'s own
    // `asContentDb` helper).
    const deps = new DepsStore(createSqlitePersistence(db as unknown as import('@kestrel/publishing').DepsPersistenceDb))
    await publishFull(driver, deps)

    expect(deps.routes().sort()).toEqual(['/', '/a', '/b'])
    expect(deps.routesForTags(['pages:1'])).toEqual(['/a']) // non-trivial: only the detail page captured this tag
    const persistedBefore = db.select().from(publishDeps).all().map((r) => r.route).sort()
    expect(persistedBefore).toEqual(['/', '/a', '/b']) // durable: written through to SQL, not just in-memory

    // The kill: wipe the persisted table directly, bypassing the in-memory DepsStore entirely.
    db.delete(publishDeps).run()
    expect(db.select().from(publishDeps).all()).toEqual([])

    // Simulate the restart `zz.publish.ts` does at boot: a FRESH DepsStore rehydrated from the (now empty)
    // persisted store.
    const rehydrated = new DepsStore(createSqlitePersistence(db as unknown as import('@kestrel/publishing').DepsPersistenceDb))
    expect(rehydrated.routes()).toEqual([]) // proves the kill: rehydration finds nothing

    // The rebuild: the production republish path — a full publish re-captures + persists deps as it renders.
    await publishFull(driver, rehydrated)

    expect(rehydrated.routes().sort()).toEqual(['/', '/a', '/b'])
    expect(rehydrated.routesForTags(['pages:1'])).toEqual(['/a'])
    const persistedAfter = db.select().from(publishDeps).all().map((r) => r.route).sort()
    expect(persistedAfter).toEqual(persistedBefore)
  })
})

// --- media derivatives: kill the generated variant files + the manifest column, rebuild by calling the
// REAL `runBackfill` (the `media:backfill` task's own function) against a real local StorageDriver.
describe('derived: media derivatives — backfill rebuild', () => {
  const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()

  it('reconstructs the derivative manifest + files after they are wiped, original untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-derived-backfill-'))
    try {
      const db = createTestDb()
      const driver = createLocalDriver({ dir, baseUrl: '/uploads' })
      const original = await png(800, 600)
      await driver.put('a/pic.png', original, 'image/png')
      db.run(sql`INSERT INTO media (storage_key, filename, mime, ext, size, width, height, derivatives, translations, created_at, updated_at)
        VALUES ('a/pic.png','pic.png','image/png','png',${original.length},800,600,'{}','{}',0,0)`)

      // Seed the derived state via the real rebuild entry point itself (this run's own output IS the
      // "before" baseline every later kill/rebuild is checked against).
      await runBackfill(db, driver, DEFAULT_IMAGE_POLICY)
      const cols = getTableColumns(media) as Record<string, never>
      const before = (db.select().from(media).where(eq(cols.id, 1)).get() as { derivatives: Record<string, { key: string; width: number; height: number; mime: string }> }).derivatives
      const beforeKeys = Object.keys(before).sort()
      expect(beforeKeys.length).toBeGreaterThan(0)
      for (const entry of Object.values(before)) expect(await driver.exists!(entry.key)).toBe(true)

      // The kill: every derivative object removed AND the manifest cleared — original stays (source of truth).
      for (const entry of Object.values(before)) await driver.delete(entry.key)
      db.run(sql`UPDATE media SET derivatives = '{}' WHERE id = 1`)
      expect(await driver.exists!('a/pic.png')).toBe(true) // the source of truth survives the kill
      for (const entry of Object.values(before)) expect(await driver.exists!(entry.key)).toBe(false)

      // The rebuild: the same function the media:backfill task runs.
      await runBackfill(db, driver, DEFAULT_IMAGE_POLICY)

      const after = (db.select().from(media).where(eq(cols.id, 1)).get() as { derivatives: Record<string, { key: string; width: number; height: number; mime: string }> }).derivatives
      expect(Object.keys(after).sort()).toEqual(beforeKeys)
      for (const key of beforeKeys) {
        expect(after[key]).toEqual(before[key]) // same key, width, height, mime — structural reconstruction
        expect(await driver.exists!(after[key]!.key)).toBe(true)
        expect((await driver.get!(after[key]!.key)).length).toBeGreaterThan(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
