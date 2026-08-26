import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()

/**
 * Every `@michaelthielemann/kestrel-*` workspace package with a `src/` dir, computed from `packages/*` on disk —
 * `create-kestrel` (no `src/`, no `@michaelthielemann/kestrel-*` name) is excluded without a hand list. Mirrors
 * `layer-edges.test.ts`'s own `kestrelPackageDirs`, kept separate to avoid a cross-file test dependency.
 */
function kestrelPackageNames(): string[] {
  const base = resolve(root, 'packages')
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => resolve(base, e.name))
    .filter((dir) => existsSync(join(dir, 'src')))
    .map((dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name as string)
    .filter((name) => name.startsWith('@michaelthielemann/kestrel-'))
}

/**
 * `test:packages`/`typecheck:packages` (package.json) and the standalone-packages step in
 * `scripts/typecheck.mjs` all glob `pnpm --filter "@michaelthielemann/kestrel-*" -r <script>` — no hand list, nothing for
 * this rail to check there. `api:check`/`api:update`/`pkg:lint` still interleave a per-package `build`
 * with a repo-root tool invocation that needs that package's own config path (`api-extractor run -c
 * packages/<name>/api-extractor.json`, `publint packages/<name>`), so they remain hand-written &&-chains —
 * this is the rail that catches a package silently missing from one of them.
 */
describe('every @michaelthielemann/kestrel-* package appears in the hand-written root script chains', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const names = kestrelPackageNames()

  it('sanity: at least the currently known packages are present (the computation itself is not vacuous)', () => {
    expect(names.length).toBeGreaterThanOrEqual(10)
  })

  for (const scriptName of ['api:check', 'api:update', 'pkg:lint']) {
    it(`${scriptName} mentions every @michaelthielemann/kestrel-* package`, () => {
      const chain = pkg.scripts[scriptName]
      expect(chain, `package.json has no "${scriptName}" script`).toBeDefined()
      const missing = names.filter((name) => !chain!.includes(name))
      expect(missing, `${scriptName} is missing: ${missing.join(', ')}`).toEqual([])
    })
  }
})
