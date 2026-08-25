import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@kestrel/auth'

/**
 * DESIGN — one running instance, `delivery: 'live'`: the runtime publisher writes static output through
 * `StorageDriver` regardless of the `delivery` selection, so one instance exercises both the static file
 * surface and the live-served surface from the same publish/retract operation. `sitemap.xml` has two
 * distinct surfaces: the live `GET /sitemap.xml` route (queries published/indexable rows directly, so it
 * is delivery-mode-agnostic) and the static `sitemap.xml` file `publish:run` writes under
 * `KESTREL_OUTPUT_DIR` (a literal key, not a per-route snapshot) — both are asserted below.
 *
 * There is no persistent live-adapter state to kill (the delivery port's write side is a no-op here; the
 * store is the only persistence and it is shared). A literal process restart is not expressible in this
 * e2e harness (one dev server per file, no supported mid-suite restart). Instead, a fresh,
 * cache-buster-qualified GET issued well after retraction still 404s — ruling out an in-process
 * cache/memoization resurrecting the retracted route.
 */

const dbPath = join(tmpdir(), `kestrel-retraction-e2e-${process.pid}.sqlite`)
const outputDir = mkdtempSync(join(tmpdir(), 'kestrel-retraction-out-'))
const PW = 'retraction-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_SITE_URL = 'https://example.test'
process.env.KESTREL_OUTPUT_DIR = outputDir
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)
process.env.KESTREL_DELIVERY = 'live'

describe('retraction: an unpublished record is unreachable in both adapters and the sitemap (e2e)', async () => {
  await setup({ rootDir: fileURLToPath(new URL('../../', import.meta.url)), dev: true })

  let cookie = ''
  beforeAll(async () => {
    const res = await testFetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    const set = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    cookie = set.map((c) => c.split(';')[0]).join('; ')
  })

  afterAll(() => {
    for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s) } catch {} }
    try { rmSync(outputDir, { recursive: true, force: true }) } catch {}
  })

  async function runPublish(): Promise<void> {
    const res = await testFetch('/_nitro/tasks/publish:run', { method: 'GET' })
    expect(res.status, 'publish:run task must succeed').toBe(200)
  }

  function staticFile(route: string): string {
    const trimmed = route.replace(/^\/+/, '').replace(/\/+$/, '')
    return join(outputDir, trimmed === '' ? 'index.html' : `${trimmed}/index.html`)
  }

  function rawDb(): Database.Database {
    return new Database(dbPath)
  }

  async function idFor(path: string): Promise<number> {
    const sqlite = rawDb()
    const row = sqlite.prepare('SELECT id FROM pages WHERE path = ?').get(path) as { id: number }
    sqlite.close()
    return row.id
  }

  async function unpublish(path: string): Promise<void> {
    const id = await idFor(path)
    await $fetch(`/api/pages/updateOne/${id}`, { method: 'POST', headers: { cookie }, body: { status: 'draft' } })
    await runPublish()
  }

  it('R1 — unpublishing removes the route from static output, live delivery, the read pipeline, and both sitemap surfaces', async () => {
    const path = '/retract-r1'
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Retract R1', path, status: 'published' },
    })
    await runPublish()

    // Before: reachable everywhere.
    expect(existsSync(staticFile(path)), 'static output must exist before retraction').toBe(true)
    expect((await testFetch(path, { method: 'GET' })).status, 'live delivery must serve it before retraction').toBe(200)
    const readApiBefore = await testFetch(`/api/deliverySnapshot?route=${encodeURIComponent(path)}`, { method: 'GET' })
    expect(readApiBefore.status, 'the read pipeline must serve it before retraction').toBe(200)
    const liveSitemapBefore = await $fetch('/sitemap.xml') as string
    expect(liveSitemapBefore, 'the live sitemap must list it before retraction').toContain(`<loc>https://example.test${path}</loc>`)
    const staticSitemapBefore = readFileSync(join(outputDir, 'sitemap.xml'), 'utf8')
    expect(staticSitemapBefore, 'the static sitemap file must list it before retraction').toContain(`<loc>https://example.test${path}</loc>`)

    await unpublish(path)

    // After: unreachable everywhere.
    expect(existsSync(staticFile(path)), 'static output file must be pruned after retraction').toBe(false)
    const liveAfter = await testFetch(path, { method: 'GET' }).catch((e) => e.response ?? e)
    expect(liveAfter.status, 'live delivery must 404 after retraction').toBe(404)
    const readApiAfter = await testFetch(`/api/deliverySnapshot?route=${encodeURIComponent(path)}`, { method: 'GET' }).catch((e) => e.response ?? e)
    expect(readApiAfter.status, 'the read pipeline (deliverySnapshot) must 404 after retraction').toBe(404)
    const liveSitemapAfter = await $fetch('/sitemap.xml') as string
    expect(liveSitemapAfter, 'the live sitemap must not list it after retraction').not.toContain(`<loc>https://example.test${path}</loc>`)
    const staticSitemapAfter = readFileSync(join(outputDir, 'sitemap.xml'), 'utf8')
    expect(staticSitemapAfter, 'the static sitemap file must not list it after retraction').not.toContain(`<loc>https://example.test${path}</loc>`)

    // The snapshot store itself: no current (non-superseded, non-retracted) row.
    const { currentSnapshot } = await import('@kestrel/publishing')
    const sqlite = rawDb()
    // `SnapshotsDb` is branded — cast at the crossing (mirrors `record-ref-index.test.ts`'s `asContentDb`).
    const current = currentSnapshot(drizzle(sqlite) as unknown as import('@kestrel/publishing').SnapshotsDb, path)
    sqlite.close()
    expect(current, 'retraction must leave no current snapshot for the route').toBeNull()
  })

  it('R2 — retraction survives a kill/rebuild of the static adapter: wiping and rebuilding output still omits the retracted route (and keeps a live control route)', async () => {
    const retractedPath = '/retract-r2-gone'
    const controlPath = '/retract-r2-control'
    await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'R2 Gone', path: retractedPath, status: 'published' } })
    await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'R2 Control', path: controlPath, status: 'published' } })
    await runPublish()
    expect(existsSync(staticFile(retractedPath))).toBe(true)
    expect(existsSync(staticFile(controlPath))).toBe(true)

    await unpublish(retractedPath)
    expect(existsSync(staticFile(retractedPath))).toBe(false)

    // Kill: wipe the entire output dir.
    rmSync(outputDir, { recursive: true, force: true })
    expect(existsSync(outputDir)).toBe(false)

    // Rebuild: the real producer, not a mocked write.
    await runPublish()

    expect(existsSync(staticFile(retractedPath)), 'a rebuild from scratch must not resurrect the retracted route').toBe(false)
    expect(existsSync(staticFile(controlPath)), 'a rebuild from scratch must still restore a still-published route').toBe(true)
    expect(readFileSync(staticFile(controlPath), 'utf8')).toContain('R2 Control')

    const rebuiltSitemap = readFileSync(join(outputDir, 'sitemap.xml'), 'utf8')
    expect(rebuiltSitemap, 'the rebuilt static sitemap must not list the retracted route').not.toContain(`<loc>https://example.test${retractedPath}</loc>`)
    expect(rebuiltSitemap, 'the rebuilt static sitemap must still list the control route').toContain(`<loc>https://example.test${controlPath}</loc>`)
  })

  it('R3 — retraction is durable across the live adapter (no persistent state to kill; a later, cache-busted GET still 404s)', async () => {
    const path = '/retract-r3'
    await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'R3', path, status: 'published' } })
    await runPublish()
    expect((await testFetch(path, { method: 'GET' })).status).toBe(200)

    await unpublish(path)
    expect((await testFetch(path, { method: 'GET' })).status).toBe(404)

    // A handful of further, distinct requests (not just the immediate check above) — rules out a
    // request-scoped or short-lived in-process memoization masking a stale positive.
    for (let i = 0; i < 3; i++) {
      const res = await testFetch(`${path}?cb=${i}-${Date.now()}`, { method: 'GET' }).catch((e) => e.response ?? e)
      expect(res.status, `retraction must stay in effect on repeated fresh requests (i=${i})`).toBe(404)
    }
  })

  // Under 'live', the sitemap route consults the snapshot store, so a directly-retracted route (row status
  // untouched) is absent from it too — the route.ts status filter and the snapshot store's current-ness
  // must both agree before a route is listed, since a listed-but-404 route is a crawler-visible
  // inconsistency.
  it('R4 — retracting the snapshot directly (row stays published) still 404s in live delivery even though the row is published', async () => {
    const path = '/retract-r4-direct'
    await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'R4 Direct', path, status: 'published' } })
    await runPublish()
    expect((await testFetch(path, { method: 'GET' })).status).toBe(200)
    const sitemapBefore = await $fetch('/sitemap.xml') as string
    expect(sitemapBefore, 'the live sitemap must list the route before its snapshot is retracted').toContain(`<loc>https://example.test${path}</loc>`)

    const { retractSnapshot } = await import('@kestrel/publishing')
    const sqlite = rawDb()
    const row = sqlite.prepare('SELECT status FROM pages WHERE path = ?').get(path) as { status: string }
    retractSnapshot(drizzle(sqlite) as unknown as import('@kestrel/publishing').SnapshotsDb, path)
    sqlite.close()
    expect(row.status, 'the row itself is untouched by a direct snapshot retraction').toBe('published')

    const liveRes = await testFetch(path, { method: 'GET' }).catch((e) => e.response ?? e)
    expect(liveRes.status, 'a directly retracted snapshot must 404 in live delivery even though the row is published').toBe(404)

    const sitemapAfter = await $fetch('/sitemap.xml') as string
    expect(sitemapAfter, 'a route whose snapshot is retracted directly must not stay listed in the live sitemap').not.toContain(`<loc>https://example.test${path}</loc>`)
  })
})
