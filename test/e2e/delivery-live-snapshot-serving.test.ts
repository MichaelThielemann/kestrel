import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@michaelthielemann/kestrel-auth'

/**
 * Delivery-live: real entrypoint. `KESTREL_DELIVERY=live` selects the live adapter. Content is
 * created/published through the real HTTP API and the real `publish:run` Nitro task, exactly as
 * `delivery-static-snapshot-parity.test.ts` does — this suite differs only in reading back through an
 * HTTP GET against the dev server instead of a static output file, since the live adapter's whole point
 * is runtime serving.
 *
 * The read API is collection-less, like `outboxDead`/`publishRuns`, so it is routed at
 * `/api/deliverySnapshot` — the URL grammar is `/api/<collection>/<pipeline>[/<id>]` or `/api/<pipeline>`
 * for a collection-less one (see `core/server/utils/pipeline-route.ts`); `/api/delivery/snapshot` would
 * resolve as collection `delivery` (not a registered collection) and 404 before the pipeline ever ran.
 */

const dbPath = join(tmpdir(), `kestrel-delivery-live-e2e-${process.pid}.sqlite`)
const outputDir = mkdtempSync(join(tmpdir(), 'kestrel-delivery-live-out-'))
const PW = 'delivery-live-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_SITE_URL = 'https://example.test'
process.env.KESTREL_OUTPUT_DIR = outputDir
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)
process.env.KESTREL_DELIVERY = 'live'

describe('delivery-live serves published snapshots at runtime, never drafts, never live-populated (e2e)', async () => {
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

  function rawDb(): Database.Database {
    return new Database(dbPath)
  }

  async function snapshotHtml(route: string): Promise<string | null> {
    const { currentSnapshot } = await import('@michaelthielemann/kestrel-publishing')
    const sqlite = rawDb()
    // `SnapshotsDb` is branded — cast at the crossing (mirrors `record-ref-index.test.ts`'s `asContentDb`).
    const db = drizzle(sqlite) as unknown as import('@michaelthielemann/kestrel-publishing').SnapshotsDb
    const snap = currentSnapshot(db, route)
    sqlite.close()
    return snap ? snap.html : null
  }

  it('B1 — a DRAFT record\'s route is not served (404), even though the row exists', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Never Published', path: '/live-b1', status: 'draft' },
    })
    // no publish:run — the row exists but has never been published, so no snapshot exists either
    const res = await testFetch('/live-b1', { method: 'GET' }).catch((e) => e.response ?? e)
    expect(res.status, 'a draft route must 404 in live delivery, not render the draft row').toBe(404)
  })

  it('B2 — a PUBLISHED record mutated afterwards (without republish) still serves the PUBLISHED snapshot, not the newer row state', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Published B2 Title', path: '/live-b2', status: 'published' },
    })
    await runPublish()

    const firstRes = await testFetch('/live-b2', { method: 'GET' })
    expect(firstRes.status).toBe(200)
    const firstBody = await firstRes.text()
    expect(firstBody).toContain('Published B2 Title')

    const sqlite = rawDb()
    const row = sqlite.prepare('SELECT id FROM pages WHERE path = ?').get('/live-b2') as { id: number }
    sqlite.close()

    // Edit the live row WITHOUT republishing: a newer draft edit over an older published snapshot.
    await $fetch(`/api/pages/updateOne/${row.id}`, {
      method: 'POST', headers: { cookie },
      body: { title: 'Mutated B2 — must not leak', status: 'draft' },
    })

    const secondRes = await testFetch('/live-b2', { method: 'GET' })
    expect(secondRes.status, 'the route must still serve the last published snapshot').toBe(200)
    const secondBody = await secondRes.text()
    expect(secondBody).toContain('Published B2 Title')
    expect(secondBody).not.toContain('Mutated B2')
  })

  it('C — a retracted snapshot\'s route 404s in live delivery', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Retract Me Live', path: '/live-c', status: 'published' },
    })
    await runPublish()
    expect((await testFetch('/live-c', { method: 'GET' })).status).toBe(200)

    const sqlite = rawDb()
    const row = sqlite.prepare('SELECT id FROM pages WHERE path = ?').get('/live-c') as { id: number }
    sqlite.close()

    await $fetch(`/api/pages/updateOne/${row.id}`, { method: 'POST', headers: { cookie }, body: { status: 'draft' } })
    await runPublish() // reconciles: retracts the now-unpublished route's current snapshot

    const res = await testFetch('/live-c', { method: 'GET' }).catch((e) => e.response ?? e)
    expect(res.status).toBe(404)
  })

  it('E — the live-served html equals the snapshot\'s html field exactly (no re-render, no injection)', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Parity Smoke', path: '/live-e', status: 'published' },
    })
    await runPublish()

    const html = await snapshotHtml('/live-e')
    expect(html, 'expected a current snapshot to exist for /live-e').not.toBeNull()

    // Mutate the row (without republishing) between the snapshot read and the HTTP GET below: a
    // re-render-from-the-live-row would now diverge from `html`, which is the whole point of this
    // assertion — a naive live-render would leak the mutation.
    const sqlite = rawDb()
    const row = sqlite.prepare('SELECT id FROM pages WHERE path = ?').get('/live-e') as { id: number }
    sqlite.close()
    await $fetch(`/api/pages/updateOne/${row.id}`, {
      method: 'POST', headers: { cookie },
      body: { title: 'Parity Smoke — must not appear, no re-render' },
    })

    const res = await testFetch('/live-e', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe(html)
  })

  it('D — the read API serves the current snapshot\'s data for a published route, publicly, and 404s for none', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Read API Smoke', path: '/live-d', status: 'published' },
    })
    await runPublish()

    // No cookie: published pageLike content is public by the existing access convention.
    // `testFetch` (this file's `fetch` import) is native `fetch` under `@nuxt/test-utils`, not `ofetch` —
    // it has no `query` option, so the query string is built into the path directly.
    const res = await testFetch(`/api/deliverySnapshot?route=${encodeURIComponent('/live-d')}`, { method: 'GET' })
    expect(res.status, 'the snapshot read API must be reachable without authentication for a published route').toBe(200)
    const payload = await res.json() as { html?: string; route?: string }
    expect(payload.html).toContain('Read API Smoke')

    const missing = await testFetch(`/api/deliverySnapshot?route=${encodeURIComponent('/live-does-not-exist')}`, { method: 'GET' }).catch((e) => e.response ?? e)
    expect(missing.status).toBe(404)
  })

  it('F — an anonymous client cannot bypass the catch-all by spoofing the producer\'s internal render header', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Header Spoof Published Title', path: '/live-f', status: 'published' },
    })
    await runPublish()

    const sqlite = rawDb()
    const row = sqlite.prepare('SELECT id FROM pages WHERE path = ?').get('/live-f') as { id: number }
    sqlite.close()
    // Stays 'published' — only the title changes. If the header ever bypassed the catch-all again, this
    // would fall through to the ordinary page render, which reads the LIVE (published) row and would
    // show the mutation — a status flip to 'draft' would make the fall-through 404 for an unrelated
    // reason (anon can't see drafts) and mask the real bypass this test exists to catch.
    await $fetch(`/api/pages/updateOne/${row.id}`, {
      method: 'POST', headers: { cookie },
      body: { title: 'Header Spoof Mutated — must not leak' },
    })

    // No cookie, no real internal renderer context — only the header a real external attacker CAN send.
    const res = await testFetch('/live-f', { method: 'GET', headers: { 'x-kestrel-publish': '1' } })
    expect(res.status, 'the spoofed header must not bypass the catch-all').toBe(200)
    const body = await res.text()
    expect(body).toContain('Header Spoof Published Title')
    expect(body).not.toContain('Header Spoof Mutated')
  })

  it('G — a published route sharing a prefix with an exempted path (/admin-guide) is still served from its own snapshot', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Admin Guide Published Title', path: '/admin-guide', status: 'published' },
    })
    await runPublish()

    const sqlite = rawDb()
    const row = sqlite.prepare('SELECT id FROM pages WHERE path = ?').get('/admin-guide') as { id: number }
    sqlite.close()
    await $fetch(`/api/pages/updateOne/${row.id}`, {
      method: 'POST', headers: { cookie },
      body: { title: 'Admin Guide Mutated — must not leak, no fall-through' },
    })

    const res = await testFetch('/admin-guide', { method: 'GET' })
    expect(res.status, '/admin-guide must be served by the catch-all, not fall through past the /admin prefix check').toBe(200)
    const body = await res.text()
    expect(body).toContain('Admin Guide Published Title')
    expect(body).not.toContain('Admin Guide Mutated')
  })

  it('H — a route whose snapshot is retracted directly (the ROW stays published) 404s in live delivery, including with a spoofed header', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Retract The Snapshot, Not The Row', path: '/live-h', status: 'published' },
    })
    await runPublish()
    expect((await testFetch('/live-h', { method: 'GET' })).status).toBe(200)

    // Retract the CURRENT snapshot at the store level — the delivery-facing fact a rename/unpublish/prune
    // eventually produces — WITHOUT touching the row's own `status`. `pipelines/route.ts` (the page's
    // underlying read) gates purely on the row's status, not on the snapshot store; it has no way to know
    // this route's snapshot is gone. The catch-all's own "no current snapshot" 404 is the only thing that
    // covers this case, which is the point of testing it directly.
    const { retractSnapshot } = await import('@michaelthielemann/kestrel-publishing')
    const retractSqlite = rawDb()
    retractSnapshot(drizzle(retractSqlite) as unknown as import('@michaelthielemann/kestrel-publishing').SnapshotsDb, '/live-h')
    retractSqlite.close()

    const sqlite = rawDb()
    const row = sqlite.prepare('SELECT status FROM pages WHERE path = ?').get('/live-h') as { status: string }
    sqlite.close()
    expect(row.status, 'the row itself must still be published — that is the whole point of this test').toBe('published')

    const res = await testFetch('/live-h', { method: 'GET' }).catch((e) => e.response ?? e)
    expect(res.status, 'a retracted snapshot must 404 even though its row is still published').toBe(404)

    const spoofed = await testFetch('/live-h', { method: 'GET', headers: { 'x-kestrel-publish': '1' } }).catch((e) => e.response ?? e)
    expect(spoofed.status, 'a spoofed internal-render header must not resurrect the retracted route either').toBe(404)
  })

  it('I — a configured redirect is honoured by the live catch-all itself (live mode is its own edge)', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Redirect Target', path: '/live-redirect-dst', status: 'published' },
    })
    await runPublish()

    await $fetch('/api/redirects/updateOne', {
      method: 'POST', headers: { cookie },
      body: { rules: [{ from: '/live-redirect-src', to: '/live-redirect-dst', status: '301' }] },
    })

    const res = await testFetch('/live-redirect-src', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.url, 'the request must have followed the configured redirect to its target').toContain('/live-redirect-dst')
    const body = await res.text()
    expect(body).toContain('Redirect Target')
  })
})
