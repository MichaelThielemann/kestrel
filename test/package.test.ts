import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

// Vitest runs from the package root.
const root = process.cwd()
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name?: string
  main?: string
  bin?: Record<string, string>
  files?: string[]
  exports?: unknown
  license?: string
  private?: boolean
  repository?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

describe('package.json — publishable', () => {
  // `private: true` blocks `npm publish` outright, and it was the state for the whole pre-release life of
  // the repo, so a stray re-add is a plausible regression that nothing else would catch until a release
  // fails. The licence fields are what make the published tarball legally usable at all.
  it('is not marked private', () => {
    expect(pkg.private).toBeUndefined()
  })

  it('declares the Apache-2.0 licence and ships its text', () => {
    expect(pkg.license).toBe('Apache-2.0')
    for (const f of ['LICENSE', 'NOTICE']) expect(existsSync(resolve(root, f)), `${f} must exist`).toBe(true)
    expect(readFileSync(resolve(root, 'LICENSE'), 'utf8')).toContain('Apache License')
  })

  it('points at its source repository', () => {
    expect(pkg.repository).toBeDefined()
  })

  for (const ext of ['galleries-secure', 'galleries-secure-proofing']) {
    it(`extension ${ext} is publishable under the same licence`, () => {
      const meta = JSON.parse(readFileSync(resolve(root, 'extensions', ext, 'package.json'), 'utf8')) as {
        private?: boolean
        license?: string
        peerDependencies?: Record<string, string>
      }
      expect(meta.private).toBeUndefined()
      expect(meta.license).toBe('Apache-2.0')
      // The engine peer must track the published scope; a stale bare `kestrel` would resolve to an
      // unrelated package on the registry rather than failing loudly.
      expect(Object.keys(meta.peerDependencies ?? {})).toContain('@michaelthielemann/kestrel')
    })
  }
})

describe('release workflow', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')

  // The tag guard only compares the tag against the ROOT manifest, so every other publishable package
  // rides on being versioned in lockstep. A package with no publish step would silently stop shipping.
  it.each(['.', 'extensions/galleries-secure', 'extensions/galleries-secure-proofing', 'packages/create-kestrel'])(
    'publishes %s',
    (dir) => {
      const meta = JSON.parse(readFileSync(resolve(root, dir, 'package.json'), 'utf8')) as { name: string }
      expect(meta.name).toBeTruthy()
      if (dir !== '.') expect(workflow, `${dir} has no publish step`).toContain(`working-directory: ${dir}`)
    },
  )

  it('skips a version already on the registry so a half-finished release can be re-run', () => {
    const script = resolve(root, '.github/publish-if-new.sh')
    expect(existsSync(script)).toBe(true)
    const src = readFileSync(script, 'utf8')
    expect(src).toContain('npm view')
    expect(src).toContain('npm publish')
    expect(workflow).not.toMatch(/^\s+run: npm publish$/m)
  })
})

describe('package.json — installable as a Nuxt meta-layer (`extends: ["@michaelthielemann/kestrel"]`)', () => {
  it('declares a `main` entry point so the BARE specifier resolves', () => {
    // Without an entry point, c12/Node resolution of the bare `kestrel` specifier fails; Nuxt then treats
    // it as a relative folder, silently drops the whole layer ("Cannot extend config from kestrel"), and
    // every server auto-import (allCollections, useDb, …) + component (KestrelLink, BlockRenderer) vanishes.
    expect(pkg.main).toBe('./nuxt.config.ts')
    expect(existsSync(resolve(root, pkg.main!))).toBe(true)
  })

  it('ships that entry point in the files whitelist', () => {
    expect(pkg.files).toContain('nuxt.config.ts')
  })

  it('exposes the `kestrel` bin and ships everything it reads at runtime', () => {
    // `bin` resolves by path from the package root, so it coexists with `main` — but the CLI reads its
    // own templates out of the installed tarball, so `templates` must be whitelisted or `kestrel init`
    // works from a checkout and fails for every real consumer.
    expect(pkg.bin?.kestrel).toBe('./scripts/kestrel.mjs')
    expect(existsSync(resolve(root, pkg.bin!.kestrel!))).toBe(true)
    for (const dir of ['scripts', 'templates']) expect(pkg.files).toContain(dir)
  })

  it('ships no template file npm would strip from the tarball', () => {
    // The `files` negations are global, and npm both removes a literal `.gitignore` and then APPLIES it,
    // silently taking its listed siblings with it. Template dotfiles are `_`-prefixed and renamed on the
    // way out (see scripts/lib/scaffold.mjs); a stray real dotfile here fails silently at publish time.
    const templates = resolve(root, 'templates')
    for (const rel of readdirSync(templates, { recursive: true }) as string[]) {
      const name = rel.split(/[\\/]/).pop()!
      expect(name.startsWith('.'), `templates/${rel} would not survive npm pack`).toBe(false)
      expect(name.endsWith('.test.ts'), `templates/${rel} is stripped by the files negations`).toBe(false)
    }
  })

  it('does not use `exports` (it would gate the published subpaths consumers rely on)', () => {
    // `kestrel/scripts/hash-password.mjs` (docs) + the deep `kestrel/layers/.../kestrel-config` type import
    // must stay reachable; an `exports` map without those keys would 404 them. `main` alone keeps all subpaths.
    expect(pkg.exports).toBeUndefined()
  })

  it('ships the build-time tools a consumer needs to compile Kestrel\'s SFCs/SCSS as runtime `dependencies`', () => {
    // A consumer's Vite/Vue build compiles Kestrel's own components from node_modules: scss blocks need
    // `sass`, and `defineProps<ImportedType>()` (the shared FieldComponentProps) needs `typescript` for
    // @vue/compiler-sfc to resolve the cross-module type. As devDependencies they'd be absent for consumers
    // → the build fails ("Failed to load TypeScript" / sass not found). They must be `dependencies`.
    for (const tool of ['sass', 'typescript']) {
      expect(pkg.dependencies, `${tool} must be a runtime dependency`).toHaveProperty(tool)
      expect(pkg.devDependencies?.[tool], `${tool} must NOT be a devDependency`).toBeUndefined()
    }
  })
})

// Every external package a SHIPPED extension source file imports must be declared as a peer/runtime
// dependency — devDependencies are NOT installed for a consumer. The in-repo workspace masks the gap by
// hoisting kestrel's own copies of drizzle-orm/zod/vue to the root node_modules, so only a real opt-in
// install (strict pnpm) outside the workspace surfaces the unresolved module. This guard catches it here.
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
const pkgNameOf = (spec: string): string => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!)
const isExternal = (spec: string): boolean =>
  !spec.startsWith('.') && !spec.startsWith('#') && !spec.startsWith('~') && !builtins.has(pkgNameOf(spec))

/** Bare module specifiers imported by a source file (static `from`/side-effect `import`, dynamic `import()`). */
function externalImports(src: string): string[] {
  const out = new Set<string>()
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(src); m; m = re.exec(src)) if (isExternal(m[1]!)) out.add(pkgNameOf(m[1]!))
  return [...out]
}

const isShippedSource = (rel: string): boolean =>
  /\.(ts|vue)$/.test(rel) && !/\.(test|dom\.test|nuxt\.test)\.ts$/.test(rel)

describe('kestrel core — the framework/utility packages layer sources import are declared', () => {
  // Framework singletons Kestrel's shipped sources import by bare specifier but must SHARE the consumer's
  // own copy of (vue/vue-router/@nuxt/kit all come bundled with the consumer's own `nuxt` install) belong in
  // peerDependencies, not dependencies — a duplicate copy in `dependencies` would break singleton identity
  // (e.g. two Vue instances). h3 and @babel/parser are not framework singletons, so they need their own
  // resolvable copy: `dependencies`. devDependencies are never installed for a consumer, so don't count.
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {})])

  const sites: Array<{ file: string; pkg: string }> = [
    { file: 'layers/core/modules/kestrel/index.ts', pkg: '@nuxt/kit' },
    { file: 'layers/core/modules/auto-discovery/index.ts', pkg: '@nuxt/kit' },
    { file: 'layers/core/modules/auto-discovery/extract-block.ts', pkg: '@babel/parser' },
    { file: 'layers/core/server/utils/crud.ts', pkg: 'h3' },
    { file: 'layers/admin/app/composables/useUnsavedGuard.ts', pkg: 'vue-router' },
    { file: 'layers/admin/app/composables/useLinkResolver.ts', pkg: 'vue' },
  ]

  it.each(sites)('$file imports $pkg (sanity: the import site is real)', ({ file, pkg: dep }) => {
    const src = readFileSync(resolve(root, file), 'utf8')
    expect(src).toMatch(new RegExp(`from ['"]${dep.replace(/[/]/g, '\\/')}['"]`))
  })

  it.each(sites)('declares $pkg as a dependency or peerDependency', ({ pkg: dep }) => {
    expect(declared, `layers/ imports "${dep}" but does not declare it — a real consumer install would fail to resolve it`).toContain(dep)
  })
})

for (const ext of ['galleries-secure', 'galleries-secure-proofing']) {
  describe(`extension ${ext} — declares every imported external dependency (publishable as an opt-in layer)`, () => {
    const dir = resolve(root, 'extensions', ext)
    const meta = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const declared = new Set([...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.peerDependencies ?? {})])

    // Scan only the SHIPPED source trees (app/, server/ — what `files` whitelists), never node_modules.
    const imported = new Set<string>()
    for (const sub of ['app', 'server']) {
      const subDir = resolve(dir, sub)
      if (!existsSync(subDir)) continue
      for (const rel of readdirSync(subDir, { recursive: true }) as string[]) {
        const p = rel.split('\\').join('/')
        if (isShippedSource(p)) for (const spec of externalImports(readFileSync(resolve(subDir, p), 'utf8'))) imported.add(spec)
      }
    }

    it('imports at least one external package (sanity: the scan found source)', () => {
      expect(imported.size).toBeGreaterThan(0)
    })

    it.each([...imported].sort().map((p) => [p]))('declares %s as a dependency or peerDependency', (p) => {
      expect(declared, `${ext} imports "${p}" but does not declare it — a real consumer install would fail to resolve it`).toContain(p)
    })
  })
}
