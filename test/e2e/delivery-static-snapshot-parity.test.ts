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
 * Delivery-static against snapshots: real entrypoint. The static-output artifact producer is exercised
 * through the real `publish:run` Nitro task (`layers/public/server/tasks/publish/run.ts`) — an HTTP call
 * against the dev server's `_nitro/tasks/*` route, not a mocked function call.
 *
 * This does NOT drive a real `nuxt generate` child process. A `nuxt generate` build takes minutes and
 * needs a fresh `.output/public` this sandbox cannot reliably produce; `publish:run` is the SAME
 * render/write engine (`publishFull`) the build-time deploy and the runtime publisher both call, so it
 * exercises the real static-writing code, but it does not prove the separate `prerender-routes`
 * build-time route-seeding module (active only when `output.auto` is off) also goes through the port.
 *
 * B — full byte-compare against a pre-split baseline. `test/e2e/fixtures/delivery-static-baseline.json`
 * (sorted relative path -> sha256 of contents) was captured in a separate git worktree checked out at the
 * pre-rewire commit, via the exact same seam this suite itself uses — `publish:run` against a fresh
 * fixture db, two pages created through the real API. The comparison itself lives in its OWN file,
 * `test/e2e/delivery-static-baseline-compare.test.ts` — sitemap/robots/llms.txt enumerate every published
 * route, so a byte-exact compare needs a db/output dir with ONLY the baseline's two pages in it, not this
 * suite's shared fixture (A2/D/E all publish their own additional routes into the same output dir).
 */

const dbPath = join(tmpdir(), `kestrel-delivery-static-e2e-${process.pid}.sqlite`)
const outputDir = mkdtempSync(join(tmpdir(), 'kestrel-delivery-static-out-'))
const PW = 'delivery-static-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_SITE_URL = 'https://example.test'
process.env.KESTREL_OUTPUT_DIR = outputDir
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('delivery-static reads exclusively from the snapshot store (e2e)', async () => {
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

  function rawDb(): Database.Database {
    return new Database(dbPath)
  }

  // The snapshot-exclusive-read contract holds at the DELIVERY layer, not the producer:
  // `DeliveryPort.rebuildAll` (and `renderRoute`'s per-route lookup) may re-populate output ONLY from the
  // snapshot store, never by touching the live content row — proven here by rebuilding straight from the
  // store's already-recorded snapshot, with NO producer run (no `publish:run`, no reconcile) in between
  // the mutation and the delivery-only rebuild.
  it('A2 — DeliveryPort.rebuildAll repopulates output from the snapshot store alone; a raw-mutated live row never reaches it', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Original Title', path: '/parity-a', status: 'published' },
    })
    await runPublish() // establishes the one recorded snapshot this test rebuilds from
    expect(readOutputHtml('/parity-a')).toContain('Original Title')

    // Mutate the live row directly via raw SQL — no publish run, no reconcile: the store's recorded
    // snapshot for this route still says "Original Title".
    const sqlite = rawDb()
    sqlite.prepare('UPDATE pages SET title = ? WHERE path = ?').run('Mutated Title', '/parity-a')
    sqlite.close()

    // Kill the output dir, then rebuild through the DELIVERY-ONLY path — the real DeliveryPort adapter,
    // fed straight from the snapshot store's own read surface (currentRoutes/currentSnapshot). This path
    // never opens the content db / `pages` table.
    rmSync(outputDir, { recursive: true, force: true })
    expect(existsSync(outputDir)).toBe(false)

    const { currentRoutes, currentSnapshot } = await import('@kestrel/publishing')
    const { createStaticDeliveryPort } = await import('@kestrel/delivery-static')
    const { createLocalDriver } = await import('@kestrel/core')

    // `SnapshotsDb` is branded — cast at the crossing (mirrors `record-ref-index.test.ts`'s `asContentDb`).
    const readDb = drizzle(rawDb()) as unknown as import('@kestrel/publishing').SnapshotsDb
    const routes = currentRoutes(readDb)
    async function* snapshots() {
      for (const route of routes) {
        const snap = currentSnapshot(readDb, route)
        if (snap) yield snap
      }
    }
    const port = createStaticDeliveryPort(createLocalDriver({ dir: outputDir, baseUrl: '/' }))
    await port.rebuildAll(snapshots())

    const html = readOutputHtml('/parity-a')
    expect(html).toContain('Original Title')
    expect(html).not.toContain('Mutated Title')
  })

  it('D — unpublishing a record prunes its route from static output and demotes its snapshot (no current snapshot)', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Retract Me', path: '/parity-retract', status: 'published' },
    })
    await runPublish()
    expect(readOutputHtml('/parity-retract')).toContain('Retract Me')

    const before = rawDb()
    const beforeRow = before.prepare("SELECT id FROM pages WHERE path = ?").get('/parity-retract') as { id: number }
    before.close()

    await $fetch(`/api/pages/updateOne/${beforeRow.id}`, {
      method: 'POST', headers: { cookie },
      body: { status: 'draft' },
    })
    await runPublish()

    const file = join(outputDir, 'parity-retract', 'index.html')
    expect(existsSync(file), 'the pruned route must not still have a static output file').toBe(false)

    const { currentSnapshot } = await import('@kestrel/publishing')
    const sqlite = rawDb()
    const db = drizzle(sqlite) as unknown as import('@kestrel/publishing').SnapshotsDb
    const current = currentSnapshot(db, '/parity-retract')
    sqlite.close()
    expect(current, 'the retracted route must have no current (non-superseded) snapshot').toBeNull()
  })

  it('E — deleting the output dir and republishing rebuilds it, without touching content tables in between', async () => {
    await $fetch('/api/pages/createOne', {
      method: 'POST', headers: { cookie },
      body: { title: 'Rebuild Me', path: '/parity-rebuild', status: 'published' },
    })
    await runPublish()
    const before = readOutputHtml('/parity-rebuild')

    rmSync(outputDir, { recursive: true, force: true })
    expect(existsSync(outputDir)).toBe(false)

    await runPublish() // no content-table write happened between the delete and this call
    const after = readOutputHtml('/parity-rebuild')
    expect(after).toBe(before)
  })
})
