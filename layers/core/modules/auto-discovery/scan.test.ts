import { describe, it, expect } from 'vitest'
import { listDefinitionFiles, collectDefinitions, collectManifestFiles, renderRegistry, renderPackageMergedRegistry, renderPackageConcatRegistry, listVueFiles, collectBlockSfcs } from './scan'

// fake fs: dir -> entries
const fakeList = (tree: Record<string, string[]>) => (dir: string): string[] => {
  const entries = tree[dir]
  if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return entries
}

describe('listDefinitionFiles', () => {
  it('returns sorted absolute .ts paths, excluding tests, .d.ts and dirs', () => {
    const list = fakeList({ '/l/server/collections': ['posts.ts', 'pages.ts', 'pages.test.ts', 'x.d.ts', 'sub'] })
    expect(listDefinitionFiles('/l/server/collections', list)).toEqual([
      '/l/server/collections/pages.ts',
      '/l/server/collections/posts.ts',
    ])
  })
  it('returns [] for a missing directory (no throw)', () => {
    expect(listDefinitionFiles('/nope', fakeList({}))).toEqual([])
  })
  it('rethrows non-ENOENT errors (e.g. permission denied)', () => {
    const denied = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    expect(() => listDefinitionFiles('/locked', denied)).toThrow(/EACCES/)
  })
})

describe('collectDefinitions', () => {
  it('gathers across layer roots, dedupes, and sorts', () => {
    const list = fakeList({
      '/a/server/collections': ['pages.ts', 'posts.ts'],
      '/b/server/collections': ['media.ts'],
    })
    expect(collectDefinitions(['/a', '/b', '/a'], 'server/collections', list)).toEqual([
      '/a/server/collections/pages.ts',
      '/a/server/collections/posts.ts',
      '/b/server/collections/media.ts',
    ])
  })

  it('a same-named file in a HIGHER-priority layer shadows the lower one (deterministic override)', () => {
    const list = fakeList({
      '/consumer/server/collections': ['pages.ts'],  // consumer override
      '/kestrel/server/collections': ['pages.ts', 'media.ts'], // built-ins
    })
    // consumer first (Nuxt `_layers` order) → its pages.ts wins; media.ts (only in kestrel) is kept once.
    // Final order is alphabetical (collectDefinitions sorts the result), not priority order.
    expect(collectDefinitions(['/consumer', '/kestrel'], 'server/collections', list)).toEqual([
      '/consumer/server/collections/pages.ts',
      '/kestrel/server/collections/media.ts',
    ])
  })
})

describe('collectManifestFiles', () => {
  it('collects each layer\'s server/db/manifest.ts, one per layer, no basename dedup', () => {
    const list = fakeList({
      '/media/server/db': ['manifest.ts', 'media-db.ts'],
      '/public/server/db': ['manifest.ts', 'publishing-db.ts'],
    })
    // both layers' manifest.ts survive despite the identical basename — unlike collectDefinitions
    expect(collectManifestFiles(['/media', '/public'], list)).toEqual([
      '/media/server/db/manifest.ts',
      '/public/server/db/manifest.ts',
    ])
  })

  it('skips a layer with no server/db dir and one with a server/db dir but no manifest.ts', () => {
    const list = fakeList({
      '/core/server/db': ['content-manifest.ts', 'module-db.ts'],
      '/media/server/db': ['manifest.ts'],
    })
    expect(collectManifestFiles(['/core', '/media', '/no-db-dir'], list)).toEqual(['/media/server/db/manifest.ts'])
  })

  it('returns [] when no layer has one', () => {
    expect(collectManifestFiles(['/a', '/b'], fakeList({}))).toEqual([])
  })
})

describe('renderRegistry', () => {
  it('emits one import per file plus a default-export array', () => {
    const code = renderRegistry(['/a/pages.ts', '/b/media.ts'])
    expect(code).toContain('import _0 from "/a/pages.ts"')
    expect(code).toContain('import _1 from "/b/media.ts"')
    expect(code).toContain('export default [_0, _1]')
  })
  it('emits an empty array for no files', () => {
    expect(renderRegistry([])).toBe('export default []')
  })
})

describe('renderPackageMergedRegistry', () => {
  it('imports each package\'s kestrelDiscovery, each consumer file, and merges via mergeKestrelDiscovered', () => {
    const code = renderPackageMergedRegistry({
      packages: ['@michaelthielemann/kestrel-media', '@michaelthielemann/kestrel-publishing'],
      property: 'collections',
      consumerFiles: ['/l/posts.ts'],
      nameOfExpr: '(x) => x.name',
    })
    expect(code).toContain(`import { kestrelDiscovery as __pkg0 } from "@michaelthielemann/kestrel-media"`)
    expect(code).toContain(`import { kestrelDiscovery as __pkg1 } from "@michaelthielemann/kestrel-publishing"`)
    expect(code).toContain(`import _c0 from "/l/posts.ts"`)
    // Resolved to a real file path, not left as the bare specifier — see resolvePackageEntry's TSDoc for why.
    expect(code).toMatch(/import \{ mergeKestrelDiscovered \} from ".*kestrel-core.*"/)
    expect(code).toContain(`mergeKestrelDiscovered([...(__pkg0.collections ?? []), ...(__pkg1.collections ?? [])], [_c0], (x) => x.name)`)
  })

  it('includes extraImports and preamble, in order, before the package imports', () => {
    const code = renderPackageMergedRegistry({
      packages: ['@michaelthielemann/kestrel-media'],
      property: 'schemaTables',
      consumerFiles: [],
      nameOfExpr: '(x) => __t(x)',
      extraImports: `import { getTableName as __t } from 'drizzle-orm'`,
      preamble: '/* seed */',
    })
    const preambleIdx = code.indexOf('/* seed */')
    const extraIdx = code.indexOf(`import { getTableName as __t }`)
    const pkgIdx = code.indexOf('__pkg0')
    expect(preambleIdx).toBeGreaterThanOrEqual(0)
    expect(preambleIdx).toBeLessThan(extraIdx)
    expect(extraIdx).toBeLessThan(pkgIdx)
  })

  it('emits a merge over two empty arrays with zero packages/files', () => {
    const code = renderPackageMergedRegistry({ packages: [], property: 'collections', consumerFiles: [], nameOfExpr: '(x) => x.name' })
    expect(code).toContain('mergeKestrelDiscovered([], [], (x) => x.name)')
  })
})

describe('renderPackageConcatRegistry', () => {
  it('concatenates every package manifest with every consumer manifest file, no dedup', () => {
    const code = renderPackageConcatRegistry({
      packages: ['@michaelthielemann/kestrel-media', '@michaelthielemann/kestrel-publishing'],
      property: 'manifest',
      consumerFiles: ['/l/manifest.ts'],
    })
    expect(code).toContain(`import { kestrelDiscovery as __pkg0 } from "@michaelthielemann/kestrel-media"`)
    expect(code).toContain(`import { kestrelDiscovery as __pkg1 } from "@michaelthielemann/kestrel-publishing"`)
    expect(code).toContain(`import _c0 from "/l/manifest.ts"`)
    expect(code).toContain(
      'export default [...(__pkg0.manifest ? [__pkg0.manifest] : []), ...(__pkg1.manifest ? [__pkg1.manifest] : []), _c0]',
    )
  })

  it('generates the ternary guard, not a bare property read, for every package item', () => {
    const code = renderPackageConcatRegistry({
      packages: ['@michaelthielemann/kestrel-no-manifest-here'],
      property: 'manifest',
      consumerFiles: [],
    })
    // The guard is what makes a mis-listed package (one without `.manifest`) contribute nothing at
    // virtual-load time instead of an `undefined` entry — asserted structurally here (the exact runtime
    // behavior of `x ? [x] : []` needs no re-proof, it's a one-line JS ternary); the real end-to-end
    // proof is the e2e boot suite building a real `#kestrel/module-manifests` virtual.
    expect(code).toContain('export default [...(__pkg0.manifest ? [__pkg0.manifest] : [])]')
    expect(code).not.toContain('export default [__pkg0.manifest]')
  })

  it('emits an empty array with nothing to contribute', () => {
    const code = renderPackageConcatRegistry({ packages: [], property: 'manifest', consumerFiles: [] })
    expect(code).toContain('export default []')
  })
})

describe('listVueFiles + collectBlockSfcs (block SFCs)', () => {
  it('returns sorted .vue paths, excluding .test.vue and non-vue entries', () => {
    const list = fakeList({ '/l/app/blocks': ['Hero.vue', 'Card.vue', 'x.test.vue', 'notes.md'] })
    expect(listVueFiles('/l/app/blocks', list)).toEqual(['/l/app/blocks/Card.vue', '/l/app/blocks/Hero.vue'])
  })
  it('returns [] for a missing app/blocks dir (no throw)', () => {
    expect(listVueFiles('/nope', fakeList({}))).toEqual([])
  })
  it('collects block SFCs across layer roots, deduped + sorted', () => {
    const list = fakeList({ '/a/app/blocks': ['Hero.vue'], '/b/app/blocks': ['Card.vue'] })
    expect(collectBlockSfcs(['/a', '/b'], 'app/blocks', list)).toEqual(['/a/app/blocks/Hero.vue', '/b/app/blocks/Card.vue'])
  })
  it('a same-named block resolves by LAYER PRIORITY (roots[0] wins), not alphabetical path order', () => {
    // roots are Nuxt _layers order (consumer/highest-priority first). A consumer Hero.vue must win the
    // schema over a node_modules layer's Hero.vue — the alphabetical sort used to hand it to the layer.
    const list = fakeList({
      '/site/app/blocks': ['Hero.vue'],
      '/site/node_modules/kestrel/layers/collections/app/blocks': ['Hero.vue'],
    })
    expect(collectBlockSfcs(['/site', '/site/node_modules/kestrel/layers/collections'], 'app/blocks', list))
      .toEqual(['/site/app/blocks/Hero.vue']) // consumer wins; the layer's Hero is not double-registered
  })
})
