import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { PACKAGE_COLLECTIONS, PACKAGE_MANIFESTS, PACKAGE_SCHEMA_TABLES } from '../../layers/core/modules/auto-discovery/package-registry'

const root = process.cwd()
const indexTs = readFileSync(resolve(root, 'layers/core/modules/auto-discovery/index.ts'), 'utf8')
const thisFile = resolve(root, 'test/architecture/kestrel-discovery.test.ts')

const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output', '.git', '.stryker-tmp', 'dist', 'coverage'])

/** Every `.ts`/`.vue` source file in the repo, skipping build/dependency directories — used by the mirror
 *  scan below (not just "the file is gone", but "nothing still points at where it used to be"). */
function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkSourceFiles(full, out)
    else if (['.ts', '.vue'].includes(extname(entry.name))) out.push(full)
  }
  return out
}

describe('the layer disk-scan shims obsoleted by direct package discovery are gone', () => {
  // The real content moved into a package earlier; a thin re-export file used to sit at each of these
  // paths ONLY so the layer disk-scan could find it. Now that the auto-discovery module reads each
  // package's own `kestrelDiscovery` export directly, these files (and the field-registry forwarder) have
  // no remaining purpose — a stray one left behind would silently double-register whatever it still names.
  const obsoletedShims = [
    'layers/media/server/collections/media.ts',
    'layers/media/server/collections/media-settings.ts',
    'layers/public/server/collections/redirects.ts',
    'layers/public/server/collections/site.ts',
    'layers/collections/server/collections/pages.ts',
    'layers/media/server/schema-tables/folders.ts',
    'layers/public/server/schema-tables/publish-deps.ts',
    'layers/public/server/schema-tables/published-snapshots.ts',
    'layers/public/server/schema-tables/publish-runs.ts',
    'layers/public/server/schema-tables/publish-status.ts',
    'layers/media/server/db/manifest.ts',
    'layers/public/server/db/manifest.ts',
    'layers/fields/server/field-registry/index.ts',
  ]

  it.each(obsoletedShims)('%s no longer exists', (rel) => {
    expect(existsSync(resolve(root, rel)), `${rel} should have been deleted once package discovery replaced it`).toBe(false)
  })

  it('nothing in the repo still REFERENCES a deleted shim\'s path (not just: the file is gone)', () => {
    // A dangling import to a deleted path is caught by typecheck too, but this rail is independent of it —
    // a `.js`-extension relative import inside a `.d.ts`-less template string, or a path baked into a test
    // fixture, would not necessarily surface as a TS error. Checked as the import-suffix (no extension,
    // since a real import drops `.ts` and may add `.js`) against every `.ts`/`.vue` file in the repo,
    // excluding this file itself (which legitimately lists the paths as data, above).
    const files = walkSourceFiles(root).filter((f) => f !== thisFile)
    const contents = files.map((f) => ({ f, text: readFileSync(f, 'utf8') }))
    for (const shim of obsoletedShims) {
      const suffix = shim.replace(/\.ts$/, '')
      const hits = contents.filter(({ text }) => text.includes(suffix)).map(({ f }) => f)
      expect(hits, `${shim} is still referenced by: ${hits.join(', ')}`).toEqual([])
    }
  })
})

describe('bidirectional consistency: PACKAGE_* vs. every real workspace package\'s actual kestrelDiscovery', () => {
  // COMPUTED against the real, built packages — not a hand-maintained list of expected results — so a
  // package that starts or stops contributing a category, or a PACKAGE_* list that falls out of sync with
  // reality (e.g. a package silently dropped from `PACKAGE_SCHEMA_TABLES`, unprovisioning its tables with
  // no error), fails here at unit speed instead of surfacing as a runtime 404/missing-table later.
  const packagesDir = resolve(root, 'packages')
  const workspacePackages = readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => JSON.parse(readFileSync(resolve(packagesDir, e.name, 'package.json'), 'utf8')) as { name: string, main?: string, exports?: unknown })
    // Real importable libraries only — `create-kestrel` is a CLI scaffold (`bin` only, no `main`/
    // `exports`), structurally incapable of exporting `kestrelDiscovery` and not a candidate for any
    // `PACKAGE_*` list; importing it would just throw "Cannot find package".
    .filter((pkg) => pkg.main !== undefined || pkg.exports !== undefined)
    .map((pkg) => pkg.name)

  async function discoveryOf(name: string): Promise<{ collections?: unknown[], schemaTables?: unknown[], manifest?: unknown } | undefined> {
    const mod = (await import(name)) as { kestrelDiscovery?: { collections?: unknown[], schemaTables?: unknown[], manifest?: unknown } }
    return mod.kestrelDiscovery
  }

  it.each(workspacePackages)('%s: every category it ACTUALLY contributes is listed, and only those', async (name) => {
    const d = await discoveryOf(name)
    if (!d) {
      expect(PACKAGE_COLLECTIONS, `${name} has no kestrelDiscovery but is in PACKAGE_COLLECTIONS`).not.toContain(name)
      expect(PACKAGE_SCHEMA_TABLES, `${name} has no kestrelDiscovery but is in PACKAGE_SCHEMA_TABLES`).not.toContain(name)
      expect(PACKAGE_MANIFESTS, `${name} has no kestrelDiscovery but is in PACKAGE_MANIFESTS`).not.toContain(name)
      return
    }
    if (d.collections?.length) expect(PACKAGE_COLLECTIONS, `${name} contributes collections but is missing from PACKAGE_COLLECTIONS`).toContain(name)
    else expect(PACKAGE_COLLECTIONS, `${name} contributes no collections but is listed in PACKAGE_COLLECTIONS`).not.toContain(name)

    if (d.schemaTables?.length) expect(PACKAGE_SCHEMA_TABLES, `${name} contributes schemaTables but is missing from PACKAGE_SCHEMA_TABLES`).toContain(name)
    else expect(PACKAGE_SCHEMA_TABLES, `${name} contributes no schemaTables but is listed in PACKAGE_SCHEMA_TABLES`).not.toContain(name)

    if (d.manifest) expect(PACKAGE_MANIFESTS, `${name} contributes a manifest but is missing from PACKAGE_MANIFESTS`).toContain(name)
    else expect(PACKAGE_MANIFESTS, `${name} contributes no manifest but is listed in PACKAGE_MANIFESTS`).not.toContain(name)
  })

  const listed = [
    ...PACKAGE_COLLECTIONS.map((name) => ({ category: 'collections' as const, name })),
    ...PACKAGE_SCHEMA_TABLES.map((name) => ({ category: 'schemaTables' as const, name })),
    ...PACKAGE_MANIFESTS.map((name) => ({ category: 'manifest' as const, name })),
  ]

  it.each(listed)('$name is listed in PACKAGE_* for $category and really contributes it', async ({ category, name }) => {
    const d = await discoveryOf(name)
    expect(d, `${name} is listed but exports no kestrelDiscovery at all`).toBeDefined()
    if (category === 'manifest') expect(d!.manifest, `${name} is in PACKAGE_MANIFESTS but has no manifest`).toBeDefined()
    else expect(d![category]?.length, `${name} is in PACKAGE_${category === 'collections' ? 'COLLECTIONS' : 'SCHEMA_TABLES'} but its ${category} is empty`).toBeGreaterThan(0)
  })
})

describe('every package whose OWN module graph reaches buildCollection() guards its barrel with the used-binding fields import, first', () => {
  // COMPUTED, not a hand-list of "media/collections/publishing" — a package earns this requirement by
  // ACTUALLY calling `buildCollection(` AT MODULE TOP LEVEL somewhere its own `src/index.ts` transitively
  // reaches via relative imports (bare specifiers like `@michaelthielemann/kestrel-core`, where `buildCollection` is only
  // DEFINED — never called at module load — are deliberately not followed). The pattern is column-0
  // `const X = buildCollection(`, matching every real collection file (site.ts/media.ts/pages.ts/…);
  // this deliberately does NOT match a helper like `ensureBuilt`'s internal, indented, only-runs-when-
  // invoked `buildCollection(c)` call inside a function body — that never executes as an import side
  // effect, so it carries none of the ADR-0029 eager-load hazard this rail exists to catch. ADR-0029:
  // importing ANY export from a package's barrel loads its whole module graph, so any such package needs
  // the guard regardless of whether `kestrel-nuxt`'s own virtuals happen to be the thing that imports it —
  // a plugin reaching in directly (as `extensions/galleries-secure/server/plugins/01.gallery-cleanup.ts`
  // does for `@michaelthielemann/kestrel-media`) hits the exact same "field types not registered yet" crash otherwise.
  const BUILD_COLLECTION_CALL = /^const \w+ = buildCollection\(/m

  function resolveRelativeImport(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null // bare specifier (another package) — deliberately not followed
    const base = resolve(join(fromFile, '..'), spec.replace(/\.js$/, ''))
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  function collectReachable(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry) || !existsSync(entry)) return seen
    seen.add(entry)
    const src = readFileSync(entry, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveRelativeImport(entry, m[1]!)
      if (resolved) collectReachable(resolved, seen)
    }
    return seen
  }

  const packagesDir = resolve(root, 'packages')
  const candidates = readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => resolve(packagesDir, e.name, 'src/index.ts'))
    .filter((entry) => existsSync(entry))
    .map((entry) => {
      const reachable = [...collectReachable(entry)]
      const buildsCollections = reachable.some((f) => BUILD_COLLECTION_CALL.test(readFileSync(f, 'utf8')))
      return { entry, buildsCollections }
    })
    .filter((c) => c.buildsCollections)

  it('found at least one package that calls buildCollection() (the rail is not vacuously passing)', () => {
    expect(candidates.length).toBeGreaterThan(0)
  })

  it.each(candidates.map((c) => c.entry))('%s opens with the used-binding fields guard', (entry) => {
    const src = readFileSync(entry, 'utf8')
    const firstImport = /^import\b.*$/m.exec(src)?.[0]
    expect(firstImport, `${entry}: no import statement found at all`).toBe("import { fieldTypes } from '@michaelthielemann/kestrel-fields'")
    expect(src, `${entry}: the imported binding must be referenced (used-binding, not a bare side-effect import)`).toMatch(/\nvoid fieldTypes\n/)
  })
})

describe('every generated virtual that can reach a package barrel seeds field types FIRST', () => {
  // ADR-0029: an ESM barrel is an eager, whole-module-graph load. All four generic virtuals (not only
  // collections/blocks, as before packages existed) can reach a package's own buildCollection() call via
  // `kestrelDiscovery` — so all four need the same field-types-seed guard, textually ahead of every package
  // import in the generated source. A honest-minimum textual pin (mirrors `packages/kestrel-publishing/
  // test/architecture/barrel-field-types.test.ts`'s own reasoning): the real ordering behavior is proven by
  // the e2e boot suite (a page create through `pages`/`media`/`site`/`redirects` — the full package +
  // consumer + field-type chain), not by this string check alone.
  const virtualAssignments = [
    { name: '#kestrel/field-types', anchor: `nitro.virtual['#kestrel/field-types']` },
    { name: '#kestrel/collections', anchor: `nitro.virtual['#kestrel/collections']` },
    { name: '#kestrel/blocks', anchor: `nitro.virtual['#kestrel/blocks']` },
    { name: '#kestrel/schema-tables', anchor: `nitro.virtual['#kestrel/schema-tables']` },
    { name: '#kestrel/module-manifests', anchor: `nitro.virtual['#kestrel/module-manifests']` },
  ]

  it.each(virtualAssignments)('%s\'s generator is present in the module', ({ anchor }) => {
    expect(indexTs).toContain(anchor)
  })

  it('every field-types-dependent seed is a used binding (`fieldTypes` referenced, never a bare import)', () => {
    expect(indexTs).toMatch(/import \{ fieldTypes as __kestrelSeed \} from '@michaelthielemann\/kestrel-fields'/)
    expect(indexTs).toMatch(/if \(!__kestrelSeed \|\| typeof __kestrelSeed !== 'object'\) throw/)
  })

  it('the field-types seed reads @michaelthielemann/kestrel-fields by BARE SPECIFIER — no layer filesystem path is constructed', () => {
    expect(indexTs).not.toMatch(/roots\.find/)
    expect(indexTs).not.toMatch(/layers.*fields.*field-registry/)
  })
})
