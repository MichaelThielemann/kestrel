import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const indexTs = readFileSync(resolve(fileURLToPath(import.meta.url), '../../../src/index.ts'), 'utf8')

describe('the barrel seeds field types before its own buildCollection() calls', () => {
  // The real regression: `site.js`/`redirects.js` call `buildCollection()` at module top level, and an ESM
  // barrel evaluates every export source in file order regardless of what a consumer actually imports
  // (ADR-0029) — so whatever registers `@kestrel/fields`' built-in field types has to be the barrel's
  // FIRST import, or an early consumer (e.g. a boot-phase plugin wanting only `ensureSnapshotTriggers`)
  // can reach those collection definitions before "text" et al. exist in the registry. Proven directly
  // below (importing only `ensureSnapshotTriggers` from a fresh module graph still leaves the registry
  // seeded); this is the honest-minimum textual pin for the OTHER half of the regression — a compliant
  // bundler respecting `"sideEffects": false` may tree-shake a bare `import '@kestrel/fields'` (it names
  // only its `field-registry` entry point, not the bare specifier this resolves to), which no runtime
  // ordering test can observe since tsc/vitest never tree-shake. Only the used-binding idiom survives that.
  it('imports @kestrel/fields as a used binding, not a bare side-effect import, as the very first import', () => {
    const firstImport = /^import\b.*$/m.exec(indexTs)?.[0]
    expect(firstImport).toMatch(/^import \{ fieldTypes \} from '@kestrel\/fields'$/)
  })

  it('references the imported binding (defeats tree-shaking of a "sideEffects": false package)', () => {
    expect(indexTs).toMatch(/\nvoid fieldTypes\n/)
  })
})

describe('the barrel actually seeds the registry before any consumer-visible collection builds', () => {
  it('has the field registry seeded immediately after importing only ensureSnapshotTriggers from a fresh module graph', async () => {
    // vitest isolates the module registry per test file (the default), so this file's very first import
    // of anything from the package is this one — the same shape an early boot-phase plugin sees.
    const { ensureSnapshotTriggers } = await import('../../src/index.js')
    expect(typeof ensureSnapshotTriggers).toBe('function')
    const { fieldTypes } = await import('@kestrel/fields')
    expect(fieldTypes.text).toBeDefined()
  })
})
