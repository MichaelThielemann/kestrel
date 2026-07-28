import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectDefinitions } from './scan'

// vitest runs from the repo root; the auto-discovery scans every layer's cwd + the app root.
const repo = process.cwd()
const roots = [repo, ...readdirSync(resolve(repo, 'layers')).map((l) => resolve(repo, 'layers', l))]

describe('auto-discovery — Kestrel ships NO file in the consumer-scanned server/field-types/ dir', () => {
  it('the server/field-types scan over Kestrel\'s own roots is empty', () => {
    // `server/field-types/` is the CONSUMER extension dir: every file there is `import _N from <path>`
    // (default import) and registered as a field type. Kestrel's own built-in registry + helpers live in
    // `layers/fields/server/field-registry/` (NOT here) precisely so they are never scanned — a stray
    // engine file (no default export) under any layer's server/field-types/ would crash the production
    // Rollup build with "has no default export". The esbuild-based vitest path tolerates it, so this
    // structural guard is the cheap regression net; a real `nuxt build` is the ultimate one.
    expect(collectDefinitions(roots, 'server/field-types')).toEqual([])
  })
})
