import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@kestrel/auth'
import { normalizeStaticOutput } from './fixtures/normalize-static-output'
import baseline from './fixtures/delivery-static-baseline.json'

/**
 * The full generate-output byte-compare against the pre-split baseline (see
 * `delivery-static-snapshot-parity.test.ts`'s own TSDoc for how the baseline was captured). This file
 * reproduces the EXACT sequence the capture ran — a fresh fixture db/output dir, the same two pages
 * created through the real API, one `publish:run` — so the resulting output tree is directly comparable:
 * no other test/route may share this db/output dir, or sitemap/robots/llms.txt (which enumerate every
 * published route) would legitimately diverge from the baseline for reasons that have nothing to do with
 * the rewire.
 *
 * Every file is hashed AFTER `normalizeStaticOutput` (see `fixtures/normalize-static-output.ts`): dev-mode
 * SSR HTML bakes in a random record id, a wall-clock `createdAt`/`updatedAt`, and the dev server's own
 * absolute repo path (module URLs) — none of which the rewire controls or a real diff could ever hold
 * still across two separate captures. The baseline JSON itself was normalized the same way before being
 * committed, so both sides of the compare are on equal footing.
 */

const dbPath = join(tmpdir(), `kestrel-delivery-static-baseline-e2e-${process.pid}.sqlite`)
const outputDir = mkdtempSync(join(tmpdir(), 'kestrel-delivery-static-baseline-out-'))
const PW = 'delivery-static-baseline-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_SITE_URL = 'https://example.test'
process.env.KESTREL_OUTPUT_DIR = outputDir
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('delivery-static byte-compares against the pre-split baseline (e2e)', async () => {
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

  it('B — byte-compares a real publish against the committed pre-split baseline', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Baseline Page One', path: '/baseline-one', status: 'published' },
    })
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Baseline Page Two', path: '/baseline-two', status: 'published' },
    })
    const res = await testFetch('/_nitro/tasks/publish:run', { method: 'GET' })
    expect(res.status, 'publish:run task must succeed').toBe(200)

    const manifest: Record<string, string> = {}
    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        const rel = relative(outputDir, full).split(sep).join('/')
        const normalized = normalizeStaticOutput(readFileSync(full, 'utf8'))
        manifest[rel] = createHash('sha256').update(normalized).digest('hex')
      }
    }
    walk(outputDir)

    // Scoped to the baseline's own keys, not full set-equality: the baseline was captured against a
    // worktree with no `.output/public` build, so `syncStaticAssets` (unchanged by this rewire) had
    // nothing to mirror — a `.output/public` present in whatever environment runs this suite legitimately
    // adds `_nuxt/**`/`uploads/**` entries the baseline never saw. Page + meta output (what the rewire
    // actually touches) is exactly what the baseline DOES cover, and is checked byte-for-byte below.
    for (const [path, sha256] of Object.entries(baseline)) {
      expect(manifest[path], `missing static output file ${path} (present in the pre-split baseline)`).toBeDefined()
      expect(manifest[path], `${path} does not byte-match the pre-split baseline`).toBe(sha256)
    }
  })
})
