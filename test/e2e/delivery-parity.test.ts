import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import sharp from 'sharp'
import { hashPassword } from '@kestrel/auth'
import { normalizeStaticOutput } from './fixtures/normalize-static-output'

/**
 * One running instance, `delivery: 'live'`. `@kestrel/delivery-static`'s `port.ts` records that the
 * runtime publisher still writes through `StorageDriver` directly regardless of the `delivery`
 * selection — so a single `delivery: 'live'` instance produces BOTH surfaces from one `publish:run`: the
 * static file under `KESTREL_OUTPUT_DIR`, and the live-served response through the catch-all. That lets
 * this suite compare same-snapshot output without running two Nuxt instances.
 *
 * The ETag format is unspecified beyond "derived from the snapshot fingerprint" — asserted here only by
 * behavior (changes when the fingerprint changes, drives a real 304), never by a literal format.
 */

const dbPath = join(tmpdir(), `kestrel-delivery-parity-e2e-${process.pid}.sqlite`)
const outputDir = mkdtempSync(join(tmpdir(), 'kestrel-delivery-parity-out-'))
const uploads = mkdtempSync(join(tmpdir(), 'kestrel-delivery-parity-up-'))
const PW = 'delivery-parity-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_SITE_URL = 'https://example.test'
process.env.KESTREL_OUTPUT_DIR = outputDir
process.env.KESTREL_MEDIA_LOCAL_DIR = uploads
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)
process.env.KESTREL_DELIVERY = 'live'
// Extra exemption for point A's HTTP item 4 (deliveryExempt exact-path). Adding it here does not affect
// any other route in this file — none of the other fixtures publish at '/health'.
process.env.KESTREL_DELIVERY_EXEMPT = '/health'

describe('delivery-parity: static output equals live-served output for the same snapshot (e2e)', async () => {
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
    try { rmSync(uploads, { recursive: true, force: true }) } catch {}
  })

  async function runPublish(): Promise<void> {
    const res = await testFetch('/_nitro/tasks/publish:run', { method: 'GET' })
    expect(res.status, 'publish:run task must succeed').toBe(200)
  }

  function staticFilePath(route: string): string {
    const trimmed = route.replace(/^\/+/, '').replace(/\/+$/, '')
    return join(outputDir, trimmed === '' ? 'index.html' : `${trimmed}/index.html`, )
  }

  function readStaticHtml(route: string): string {
    const file = staticFilePath(route)
    expect(existsSync(file), `expected static output file for ${route} at ${file}`).toBe(true)
    return readFileSync(file, 'utf8')
  }

  async function liveHtml(route: string): Promise<string> {
    const res = await testFetch(route, { method: 'GET' })
    expect(res.status, `expected live delivery to serve ${route}`).toBe(200)
    return res.text()
  }

  async function assertParity(route: string): Promise<void> {
    const staticHtml = normalizeStaticOutput(readStaticHtml(route))
    const live = normalizeStaticOutput(await liveHtml(route))
    expect(live, `normalized live HTML must equal normalized static HTML for ${route}`).toBe(staticHtml)
  }

  it('A1 — a plain page: static file HTML === live-served HTML (normalized), non-vacuously', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Parity Plain Page', path: '/parity-plain', status: 'published' },
    })
    await runPublish()

    await assertParity('/parity-plain')

    // Non-vacuity: corrupt the static side, prove the comparison actually detects it, then restore.
    const file = staticFilePath('/parity-plain')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.replace('Parity Plain Page', 'CORRUPTED FOR TEST'))
    const corruptedStatic = normalizeStaticOutput(readFileSync(file, 'utf8'))
    const live = normalizeStaticOutput(await liveHtml('/parity-plain'))
    expect(corruptedStatic, 'the parity assertion must be sensitive to a real content divergence').not.toBe(live)
    writeFileSync(file, original)
    expect(normalizeStaticOutput(readFileSync(file, 'utf8'))).toBe(live)
  })

  it('A2 — a localized route (locale prefix): static file HTML === live-served HTML (normalized)', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Parity Lokalisiert', path: '/parity-locale', locale: 'de', status: 'published' },
    })
    await runPublish()

    await assertParity('/de/parity-locale')
  })

  it('A3 — a route with media: static file HTML === live-served HTML (normalized), media URL present on both', async () => {
    const png = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'parity.png')
    const media = await $fetch('/api/media/upload', { method: 'POST', headers: { cookie }, body: form }) as { id: number }

    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: {
        title: 'Parity Media Page', path: '/parity-media', status: 'published',
        content: [{ id: 'h', type: 'hero', props: { heading: 'Parity Media Heading', image: media.id } }],
      },
    })
    await runPublish()

    const staticHtml = readStaticHtml('/parity-media')
    expect(staticHtml).toMatch(/<img[^>]+src="\/uploads\//)
    await assertParity('/parity-media')
  })

  it('H1 — live responses carry Cache-Control and a fingerprint-derived ETag; a conditional GET 304s and tracks content changes', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Cache Etag Page v1', path: '/parity-cache', status: 'published' },
    })
    await runPublish()

    const first = await testFetch('/parity-cache', { method: 'GET' })
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control'), 'expected a Cache-Control header on a live response').toBeTruthy()
    const etag1 = first.headers.get('etag')
    expect(etag1, 'expected an ETag header on a live response').toBeTruthy()

    const conditional = await testFetch('/parity-cache', { method: 'GET', headers: { 'if-none-match': etag1! } })
    expect(conditional.status, 'a conditional GET with a matching If-None-Match must 304').toBe(304)

    const listConditional = await testFetch('/parity-cache', { method: 'GET', headers: { 'if-none-match': `"stale-one", ${etag1!}, "stale-two"` } })
    expect(listConditional.status, 'a comma-separated If-None-Match list containing the current ETag must 304').toBe(304)

    const wildcardConditional = await testFetch('/parity-cache', { method: 'GET', headers: { 'if-none-match': '*' } })
    expect(wildcardConditional.status, 'a bare "*" If-None-Match must 304 for an existing resource').toBe(304)

    const sqlite = new (await import('better-sqlite3')).default(dbPath)
    const row = sqlite.prepare('SELECT id FROM pages WHERE path = ?').get('/parity-cache') as { id: number }
    sqlite.close()
    await $fetch(`/api/pages/updateOne/${row.id}`, { method: 'POST', headers: { cookie }, body: { title: 'Cache Etag Page v2' } })
    await runPublish()

    const second = await testFetch('/parity-cache', { method: 'GET' })
    const etag2 = second.headers.get('etag')
    expect(etag2, 'expected an ETag after republish').toBeTruthy()
    expect(etag2, 'the ETag must change when the underlying snapshot fingerprint changes').not.toBe(etag1)

    const staleConditional = await testFetch('/parity-cache', { method: 'GET', headers: { 'if-none-match': etag1! } })
    expect(staleConditional.status, 'a stale If-None-Match (old fingerprint) must not 304 after content changed').toBe(200)
  })

  it('H2 — trailing-slash: /route/ serves the same normalized content as /route', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Trailing Slash Page', path: '/parity-trailing', status: 'published' },
    })
    await runPublish()

    const noSlash = await testFetch('/parity-trailing', { method: 'GET' })
    expect(noSlash.status).toBe(200)
    const withSlash = await testFetch('/parity-trailing/', { method: 'GET' })
    expect(withSlash.status, '/route/ must serve the same route as /route, not 404').toBe(200)
    expect(normalizeStaticOutput(await withSlash.text())).toBe(normalizeStaticOutput(await noSlash.text()))
  })

  it('H3 — HEAD returns the same headers as GET, no body, correct content-length', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Head Method Page', path: '/parity-head', status: 'published' },
    })
    await runPublish()

    const get = await testFetch('/parity-head', { method: 'GET' })
    expect(get.status).toBe(200)
    const getBody = await get.text()

    const head = await testFetch('/parity-head', { method: 'HEAD' })
    expect(head.status, 'HEAD must succeed like GET').toBe(200)
    const headBody = await head.text()
    expect(headBody, 'HEAD must not return a body').toBe('')
    const headLength = head.headers.get('content-length')
    expect(headLength, 'HEAD must report a Content-Length').toBeTruthy()
    expect(Number(headLength)).toBe(Buffer.byteLength(getBody, 'utf8'))
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'))
  })

  it('H4 — deliveryExempt exact-path: config [\'/health\'] exempts GET /health exactly from the catch-all', async () => {
    const marker = 'Health Check Content Must Not Serve'
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: marker, path: '/health', status: 'published' },
    })
    // Sibling, non-exempted control route: proves this instance's catch-all does serve published content
    // for an ordinary route, so H4's assertion on '/health' is a real exemption check, not a false
    // negative from something else being broken.
    const controlMarker = 'Health Sibling Control Content'
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: controlMarker, path: '/health-sibling', status: 'published' },
    })
    await runPublish()

    const control = await testFetch('/health-sibling', { method: 'GET' })
    expect(control.status).toBe(200)
    expect(await control.text()).toContain(controlMarker)

    const res = await testFetch('/health', { method: 'GET' }).catch((e) => e.response ?? e)
    const body = res.status === 200 ? await res.text() : ''
    expect(body, 'GET /health must be exempted from the live catch-all and must not serve the published snapshot').not.toContain(marker)
  })
})
