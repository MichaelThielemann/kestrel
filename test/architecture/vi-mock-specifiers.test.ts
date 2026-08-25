import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

const root = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', '.nuxt', '.output', '.data', 'graphify-out', '.stryker-tmp', '.superpowers'])
const SELF = resolve(root, 'test/architecture/vi-mock-specifiers.test.ts')

/**
 * Every `vi.mock('<literal specifier>')` call across the repo's `*.test.ts` files, with the file it was
 * found in. A `vi.mock(someVariable)` (no test file does this today) is not collected — nothing to check
 * a runtime value against statically, and the plain regex would false-positive on it as a "specifier"
 * anyway.
 */
function findViMockCalls(): Array<{ file: string; spec: string }> {
  const out: Array<{ file: string; spec: string }> = []
  const viMockRe = /\bvi\.mock\(\s*(['"])((?:[^'"\\]|\\.)*)\1/g
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.test.ts')) continue
      if (full === SELF) continue // this file's own doc comment and error-message templates contain
      // `vi.mock(...)`-shaped text that is not a real mock call — scanning it would self-match.
      const text = readFileSync(full, 'utf8')
      for (const m of text.matchAll(viMockRe)) out.push({ file: full, spec: m[2] })
    }
  }
  walk(root)
  return out
}

/** `true` if a relative specifier resolves to a real file from the importing test file's own directory —
 *  covers a bare module (`.ts` appended), an explicit `.js` specifier resolving to its `.ts` source (the
 *  NodeNext convention every package here compiles under), and a directory's `index.ts`. */
function relativeSpecifierResolves(fromDir: string, spec: string): boolean {
  const base = resolve(fromDir, spec)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    base.endsWith('.js') ? base.replace(/\.js$/, '.ts') : `${base}.js`,
    join(base, 'index.ts'),
  ]
  return candidates.some((c) => existsSync(c))
}

/** The nearest `package.json` walking up from `fromDir` — a workspace package's own manifest, or the
 *  root's for anything under `layers/`, `test/`, `extensions/`, etc. which have none of their own. */
function nearestPackageJson(fromDir: string): { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'))
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no package.json found above ${fromDir}`)
    dir = parent
  }
}

/** The package name a bare specifier resolves against — the scope+name for `@scope/name/sub/path`, the
 *  first segment for `name/sub/path`. */
function packageNameOf(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function bareSpecifierIsADependency(fromDir: string, spec: string): boolean {
  const pkg = nearestPackageJson(fromDir)
  const name = packageNameOf(spec)
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name])
}

describe('every vi.mock() specifier resolves', () => {
  const calls = findViMockCalls()

  it('sanity: at least the pre-existing mocks were found (the scan itself is not vacuous)', () => {
    expect(calls.length).toBeGreaterThan(10)
  })

  for (const { file, spec } of calls) {
    const rel = file.slice(root.length + 1)
    it(`${rel} → vi.mock('${spec}')`, () => {
      const isRelative = spec.startsWith('.') || spec.startsWith('/')
      const ok = isRelative ? relativeSpecifierResolves(dirname(file), spec) : bareSpecifierIsADependency(dirname(file), spec)
      expect(ok, isRelative
        ? `${rel}: vi.mock('${spec}') does not resolve to a real file — the mock has gone dark (real import) or the file moved`
        : `${rel}: vi.mock('${spec}') — '${packageNameOf(spec)}' is not a dependency of the nearest package.json above this test`).toBe(true)
    })
  }
})
