import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import { setup, fetch as testFetch } from '@nuxt/test-utils/e2e'

/**
 * Tests handler precedence: what happens when a consumer's own app defines a server route at the exact
 * path a Kestrel layer already provides one. Kestrel's own routes are all
 * plain files under a layer's `server/api`/`server/routes` (Nitro's own directory-scan convention — see
 * docs/internals/architecture.md's "Nitro's OWN disk-scanned directories" note), not `addServerHandler`-registered;
 * the closest real "module-registered route" a consumer could collide with by NAME is the one file behind
 * the whole pipeline URL scheme, `layers/core/server/api/[...path].ts`. The fixture consumer at
 * `test/e2e/fixtures/handler-precedence-consumer` ships its own `server/api/[...path].ts` — an EXACT
 * filename/pattern collision.
 *
 * PINNED FINDING (this Nuxt 4.5 / Nitro 2.13 pair): the consumer's own file WINS — Nitro extends the
 * standard app-overrides-layer convention (pages, layouts, `app.vue`) to server routes too, so a
 * consumer's `server/api/[...path].ts` shadows the engine's pipeline dispatcher entirely, not just for
 * overlapping paths. This is the SAME override precedence a consumer can lean on deliberately (e.g.
 * wrapping the dispatcher) or trip over by accident (a same-named file silently swallowing every
 * `/api/*` request).
 */
const dbPath = join(tmpdir(), `kestrel-handler-precedence-e2e-${process.pid}.sqlite`)
process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'

describe('handler precedence: a consumer\'s own server/api/[...path].ts vs. Kestrel\'s', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/handler-precedence-consumer', import.meta.url)),
    dev: true,
  })

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix) } catch { /* not created if the suite failed before boot */ }
    }
  })

  it('the consumer app\'s own route wins over the extended layer\'s file of the same name', async () => {
    const res = await testFetch('/api/anything-not-a-real-pipeline')
    const body = await res.json() as Record<string, unknown>
    expect(
      body.marker,
      'the consumer\'s own server/api/[...path].ts should answer — if this ever comes back undefined/'
        + 'different, a Nuxt/Nitro upgrade changed the app-overrides-layer precedence for server routes and '
        + 'this file\'s own PINNED FINDING comment needs re-verifying, not silently updating',
    ).toBe('consumer-owned-handler')
  })

  it('the colliding route is reachable at all (a byte-discipline check on the fixture itself)', async () => {
    const res = await testFetch('/api/anything-not-a-real-pipeline')
    expect(res.status, 'the colliding route 404s or errors outright — the fixture itself is broken, not a precedence finding').not.toBe(404)
  })
})
