import { describe, it, expect } from 'vitest'
import { listDefinitionFiles, collectDefinitions, renderRegistry, listVueFiles, collectBlockSfcs } from './scan'

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
