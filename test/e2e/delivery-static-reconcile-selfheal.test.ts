import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@kestrel/auth'

/**
 * Real production wiring (`zz.publish.ts`) enqueues an incremental publish on every write when
 * `output.publishOnSave` is on, through an in-memory queue that is NOT durable — a crash between the
 * enqueue and the flush loses that publish silently, with no record it ever should have happened. This
 * suite's own dev-mode harness already reproduces exactly that hole for free: `zz.publish.ts` returns
 * immediately in dev (`if (import.meta.dev) return`), so an edit here NEVER reaches an incremental publish
 * on its own — the only way it's ever picked up is a full reconcile (`publish:run`, the boot publish, or
 * the reconciler) noticing the drift.
 */

const dbPath = join(tmpdir(), `kestrel-delivery-static-selfheal-e2e-${process.pid}.sqlite`)
const outputDir = mkdtempSync(join(tmpdir(), 'kestrel-delivery-static-selfheal-out-'))
const PW = 'delivery-static-selfheal-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_SITE_URL = 'https://example.test'
process.env.KESTREL_OUTPUT_DIR = outputDir
process.env.KESTREL_OUTPUT_PUBLISH_ON_SAVE = 'true'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('reconcile self-heals a lost incremental invalidation (e2e)', async () => {
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

  function readOutputHtml(route: string): string {
    const key = route === '/' ? 'index.html' : `${route.replace(/^\/+/, '').replace(/\/+$/, '')}/index.html`
    const file = join(outputDir, key)
    expect(existsSync(file), `expected static output file for ${route} at ${file}`).toBe(true)
    return readFileSync(file, 'utf8')
  }

  it('a real pipeline edit whose incremental publish never fired still converges on the next reconcile', async () => {
    const created = await $fetch<{ id: number }>('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Stale Title', path: '/selfheal', status: 'published' },
    })
    await runPublish() // bootstrap: no snapshot exists yet, always records + delivers
    expect(readOutputHtml('/selfheal')).toContain('Stale Title')

    // The lost invalidation: a real pipeline write (`output.publishOnSave: true` means this is meant to be
    // live immediately), but this dev-mode harness's `zz.publish.ts` never runs at all — so no incremental
    // publish ever fires for it. The route's recorded snapshot is now stale relative to the live row.
    await $fetch(`/api/pages/updateOne/${created.id}`, {
      method: 'POST', headers: { cookie },
      body: { title: 'Healed Title' },
    })

    // Three reconcile runs — not just one: each is a full, independent fingerprint comparison, so if the
    // first one converges the rest are idempotent no-ops.
    await runPublish()
    await runPublish()
    await runPublish()

    const html = readOutputHtml('/selfheal')
    expect(html).toContain('Healed Title')
    expect(html).not.toContain('Stale Title')
  })
})
