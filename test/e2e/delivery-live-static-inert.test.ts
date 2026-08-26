import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@michaelthielemann/kestrel-auth'

/**
 * The default delivery config ('static'): the live catch-all must be INERT — no `KESTREL_DELIVERY`
 * override here, mirroring resolveKestrel's own documented default.
 *
 * The observable chosen for "inert" is the read-API endpoint (`GET /api/deliverySnapshot`), not the
 * content route's own URL. The content route itself is already answered under 'static' by an existing
 * pre-split live-render page (confirmed empirically: `GET /live-a-inert` on a fresh checkout returns 200
 * with the row's current content, not 404) — that page is out of scope here (publisher.ts/render-live.ts
 * internals) and this suite must not assume anything about its future behavior either way. The read-API
 * surface has no such legacy occupant, so "does the live delivery module answer here" is unambiguous: it
 * must be reachable when `delivery: 'live'` and absent/denied when `delivery: 'static'` (asserted here).
 */

const dbPath = join(tmpdir(), `kestrel-delivery-live-inert-e2e-${process.pid}.sqlite`)
const outputDir = mkdtempSync(join(tmpdir(), 'kestrel-delivery-live-inert-out-'))
const PW = 'delivery-live-inert-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_SITE_URL = 'https://example.test'
process.env.KESTREL_OUTPUT_DIR = outputDir
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)
delete process.env.KESTREL_DELIVERY // explicit: exercise the default, not a leftover from another file

describe('delivery-live is inert under the default delivery: "static" config (e2e)', async () => {
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

  it('A — the live delivery read API is inert (not 200) when delivery is "static" (default), even though a snapshot for the route exists', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Static Mode Only', path: '/live-a-inert', status: 'published' },
    })
    await testFetch('/_nitro/tasks/publish:run', { method: 'GET' }) // records a snapshot regardless of delivery mode

    // `testFetch` is native `fetch` here, which has no `query` option — the query string is built into
    // the path directly.
    const res = await testFetch(`/api/deliverySnapshot?route=${encodeURIComponent('/live-a-inert')}`, { method: 'GET', headers: { cookie } }).catch((e) => e.response ?? e)
    expect(res.status, 'the live delivery read API must not serve snapshot content when delivery is "static"').not.toBe(200)
  })
})
