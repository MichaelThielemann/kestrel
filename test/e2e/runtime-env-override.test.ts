import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import { setup, startServer } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@kestrel/auth'

// The build-time default DB path (baked into runtimeConfig by the `kestrel` module at `nuxt build`) vs.
// the path a `NUXT_KESTREL_DB_PATH` override — set ONLY on the already-built server's process, never seen
// by the build — should redirect to. Distinct pid-scoped tmp files so a leftover run can't collide.
const buildTimeDbPath = join(tmpdir(), `kestrel-runtimeenv-build-${process.pid}.sqlite`)
const overrideDbPath = join(tmpdir(), `kestrel-runtimeenv-override-${process.pid}.sqlite`)
const PW = 'e2e-runtimeenv-pw'

process.env.KESTREL_DB = buildTimeDbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)
process.env.KESTREL_SITE_URL = 'https://example.test'

describe('NUXT_KESTREL_DB_PATH — runtime env override on a prebuilt server (e2e)', async () => {
  // `server: false` builds once via `setup()` without auto-starting it, so the test controls each
  // `startServer()` call's env itself — proving the override applies to an ALREADY-BUILT artifact.
  await setup({
    rootDir: fileURLToPath(new URL('../../', import.meta.url)),
    dev: false,
    build: true,
    server: false,
  })

  // No manual `stopServer()` here: `setup()`'s own `afterAll` (registered above, so it runs AFTER this
  // one) already stops whatever server it finds on `ctx.serverProcess`, correctly wrapped with the test
  // context set/cleared. Calling `stopServer()` from here would run against a context this library's own
  // `afterEach` has already cleared (`useTestContext()` throws "No context is available").
  afterAll(() => {
    for (const base of [buildTimeDbPath, overrideDbPath]) {
      for (const suffix of ['', '-wal', '-shm']) { try { rmSync(base + suffix) } catch {} }
    }
  })

  it('redirects the DB to the override path without a rebuild, leaving the build-time default untouched', async () => {
    expect(existsSync(buildTimeDbPath)).toBe(false)
    expect(existsSync(overrideDbPath)).toBe(false)

    // KESTREL_DB (the build-time env) is NOT changed here — only the server process's env differs, and
    // the build already happened in `setup()` above, before this env var even existed.
    await startServer({ env: { NUXT_KESTREL_DB_PATH: overrideDbPath } })

    // The boot-time schema-sync plugin opens (and creates) the DB file immediately, before any request.
    expect(existsSync(overrideDbPath)).toBe(true)
    expect(existsSync(buildTimeDbPath)).toBe(false)
  })
})
