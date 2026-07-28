import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

// The package root (where drizzle.config.ts lives) is the parent of this test's `test/` dir. drizzle-kit
// must migrate the DB anchored here — the same `rootDir` the Nuxt app uses — regardless of where the CLI
// is invoked from (in a pnpm workspace, `process.cwd()` is often NOT the package root).
const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')

describe('drizzle.config — DB anchor is the package root, not process.cwd()', () => {
  const orig = process.cwd()
  afterEach(() => process.chdir(orig))

  it('resolves the configured DB under the package root even when invoked from another directory', async () => {
    process.chdir(tmpdir())
    const cfg = (await import('../drizzle.config?cwdcheck')).default as { dbCredentials: { url: string } }
    // kestrel.config sets db: '.data/dev.sqlite'; the point of this test is that it resolves under the
    // package root (not the tmpdir cwd), so drizzle-kit migrates exactly the DB the app opens.
    expect(cfg.dbCredentials.url).toBe(`${repoRoot}/.data/dev.sqlite`)
  })
})
