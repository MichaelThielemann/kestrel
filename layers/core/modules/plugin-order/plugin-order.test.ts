import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { PLUGIN_ORDER, resolvePluginOrder, validatePluginOrder, type PluginEntry } from './plugin-order'

// vitest runs from the repo root; mirrors no-engine-field-types.test.ts's real-roots pattern.
const repo = process.cwd()
const roots = [repo, ...readdirSync(resolve(repo, 'layers')).map((l) => resolve(repo, 'layers', l))]

describe('PLUGIN_ORDER', () => {
  it('has exactly one entry per real plugin file — no more, no fewer (computed against reality)', () => {
    // The pure completeness proof: if this passes, validatePluginOrder(roots) cannot throw.
    expect(() => validatePluginOrder(roots)).not.toThrow()
  })

  it('marks exactly the one documented cross-layer dependency plus the two intra-core ordering pairs as order-sensitive (a non-empty after:)', () => {
    const sensitive = PLUGIN_ORDER.filter((p) => p.after.length > 0).map((p) => `${p.layer}/${p.file}`)
    expect(sensitive.sort()).toEqual([
      'core/server/plugins/00.migrate.ts',
      'core/server/plugins/02.schema-sync.ts',
      'public/server/plugins/00.ensure-snapshot-triggers.ts',
    ].sort())
  })

  it('every after: dependency names a real, distinct entry (no self-reference, no dangling key)', () => {
    const keys = new Set(PLUGIN_ORDER.map((p) => `${p.layer}/${p.file}`))
    for (const p of PLUGIN_ORDER) {
      const ownKey = `${p.layer}/${p.file}`
      for (const dep of p.after) {
        expect(dep, `${ownKey} must not depend on itself`).not.toBe(ownKey)
        expect(keys.has(dep), `${ownKey} declares after: "${dep}", which is not a real PLUGIN_ORDER entry`).toBe(true)
      }
    }
  })
})

describe('validatePluginOrder — LOUD on both a completeness drift AND an after: reshuffle', () => {
  it('does not throw against the real, unmodified repo', () => {
    expect(() => validatePluginOrder(roots)).not.toThrow()
  })

  it('throws when a real on-disk plugin is missing from the declared list (mutant: remove an entry)', () => {
    const mutated = PLUGIN_ORDER.slice(0, -1) // drop the last real entry (zz.publish.ts)
    expect(() => validatePluginOrder(roots, mutated)).toThrow(/on disk but NOT declared/i)
  })

  it('throws when the declared list names a file that does not exist (mutant: add a phantom entry)', () => {
    const mutated: typeof PLUGIN_ORDER = [
      ...PLUGIN_ORDER,
      { layer: 'core', file: 'server/plugins/99.phantom.ts', after: [], evidence: 'does not exist, planted by the mutant test' },
    ]
    expect(() => validatePluginOrder(roots, mutated)).toThrow(/does not exist/i)
  })

  it('throws when a reshuffle moves 00.migrate AFTER 02.schema-sync — the reviewer\'s own mutant', () => {
    const migrateIdx = PLUGIN_ORDER.findIndex((p) => p.file === 'server/plugins/00.migrate.ts' && p.layer === 'core')
    const schemaSyncIdx = PLUGIN_ORDER.findIndex((p) => p.file === 'server/plugins/02.schema-sync.ts' && p.layer === 'core')
    const mutated = [...PLUGIN_ORDER]
    // Swap the two positions — 02.schema-sync now runs before 00.migrate, which its own after: still names.
    const migrate = mutated[migrateIdx]!
    const schemaSync = mutated[schemaSyncIdx]!
    mutated[migrateIdx] = schemaSync
    mutated[schemaSyncIdx] = migrate
    expect(() => validatePluginOrder(roots, mutated)).toThrow(/violates a declared after: dependency/i)
  })

  it('throws when ensure-snapshot-triggers is reshuffled ahead of 00.migrate', () => {
    const targetIdx = PLUGIN_ORDER.findIndex((p) => p.file === 'server/plugins/00.ensure-snapshot-triggers.ts')
    const mutated = [...PLUGIN_ORDER]
    const [entry] = mutated.splice(targetIdx, 1)
    mutated.unshift(entry!) // move it to the very front — ahead of everything it depends on
    expect(() => validatePluginOrder(roots, mutated)).toThrow(/violates a declared after: dependency/i)
  })
})

describe('resolvePluginOrder', () => {
  it('resolves every declared entry to a real, existing absolute path, in declared order', () => {
    const resolved = resolvePluginOrder(roots)
    expect(resolved).toHaveLength(PLUGIN_ORDER.length)
    expect(resolved[0]).toMatch(/layers[/\\]core[/\\]server[/\\]plugins[/\\]00\.config\.ts$/)
    expect(resolved[resolved.length - 1]).toMatch(/layers[/\\]public[/\\]server[/\\]plugins[/\\]zz\.publish\.ts$/)
  })
})

describe('the drift scan mirrors Nitro\'s REAL plugin glob — recursive, all 8 extensions', () => {
  // Fully isolated: a throwaway temp directory tree, not the real repo — writing into layers/core/server/
  // plugins/ directly raced test/architecture/kestrel-discovery.test.ts and this file's own OTHER describe
  // blocks (both also call validatePluginOrder(roots) against the SAME real filesystem, concurrently,
  // across separate test files vitest does not serialize against each other).
  let tmp: string
  let fakeRoots: string[]
  const fakeList: PluginEntry[] = [
    { layer: 'fake-layer', file: 'server/plugins/00.real.ts', after: [], evidence: 'the one real declared plugin in this isolated fixture' },
  ]

  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true })
  })

  function seedFixture(): void {
    tmp = mkdtempSync(join(tmpdir(), 'kestrel-plugin-order-'))
    const layerDir = join(tmp, 'layers', 'fake-layer')
    const pluginsDir = join(layerDir, 'server', 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(join(pluginsDir, '00.real.ts'), 'export default defineNitroPlugin(() => {})\n')
    fakeRoots = [layerDir]
  }

  it('throws when a real Nitro-scannable file sits in a NESTED subdirectory (mutant: a real plugin would silently boot unaccounted-for)', () => {
    seedFixture()
    const nestedDir = join(tmp, 'layers', 'fake-layer', 'server', 'plugins', '__mutant_nested__')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(join(nestedDir, 'sneaky.ts'), 'export default defineNitroPlugin(() => {})\n')
    expect(() => validatePluginOrder(fakeRoots, fakeList)).toThrow(/on disk but NOT declared/i)
  })

  it('throws when a real Nitro-scannable .mjs file is undeclared (mutant: a non-.ts extension Nitro still scans)', () => {
    seedFixture()
    writeFileSync(join(tmp, 'layers', 'fake-layer', 'server', 'plugins', '01.sneaky.mjs'), 'export default defineNitroPlugin(() => {})\n')
    expect(() => validatePluginOrder(fakeRoots, fakeList)).toThrow(/on disk but NOT declared/i)
  })
})
