import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { buildPipelineIndex, clearPipelines, clearRegistry, registerCollection } from '@kestrel/core'
import type { PipelineDescriptor } from '@kestrel/core'
import { pagesCollection as pages } from '@kestrel/collections'
import { extractPortGraph, stepOrderRespectsInvariant, VALIDATING_WRITE_OPS } from '../../scripts/port-graph.mjs'

// Boots the real registered pipelines exactly like pipeline-invariants.test.ts, so `index` reflects the
// same runtime composition the registry-based pipeline-invariants test asserts against.
Object.assign(globalThis, {
  defineNitroPlugin: (fn: () => void) => fn,
  useRuntimeConfig: () => ({
    kestrel: { output: { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: true, publishOnSave: false, reconcileMinutes: 0, verbose: false, s3: {} } },
  }),
  useDb: () => drizzle(new Database(':memory:')),
  primaryLocale: () => 'en',
  prefixPrimaryLocale: () => false,
})

let index: PipelineDescriptor[]

beforeAll(async () => {
  clearRegistry()
  registerCollection(pages)
  clearPipelines()
  const publishPlugin = (await import('../../layers/public/server/plugins/zz.publish')).default as unknown as () => void
  vi.useFakeTimers()
  publishPlugin()
  vi.useRealTimers()
  index = buildPipelineIndex()
})

afterAll(() => {
  clearRegistry()
  clearPipelines()
})

describe('port-graph cross-check (validate-before-persist re-expressed as a port-graph query)', () => {
  it('the extracted definePipeline step chains agree with the registry-composed index for every VALIDATING_WRITE_OP', () => {
    const { pipelines } = extractPortGraph()
    let checked = 0
    for (const op of VALIDATING_WRITE_OPS) {
      const staticPipeline = pipelines.find((p) => p.name === op)
      expect(staticPipeline, `no statically extracted definePipeline() found for "${op}"`).toBeDefined()
      const portGraphAnswer = stepOrderRespectsInvariant(staticPipeline!.steps)

      const registryDescriptor = index.find((p) => p.collection === 'pages' && p.name === op)
      expect(registryDescriptor, `no registry-composed pipeline found for pages/${op}`).toBeDefined()
      const registryAnswer = stepOrderRespectsInvariant(registryDescriptor!.steps.map((s) => s.name))

      expect(portGraphAnswer, `port-graph query for "${op}" disagrees with the registry-based answer`).toBe(registryAnswer)
      expect(registryAnswer, `registry-composed "${op}" does not put validate before persist`).toBe(true)
      checked++
    }
    expect(checked).toBe(VALIDATING_WRITE_OPS.size)
  })

  it('stepOrderRespectsInvariant flags a violation when persist precedes validate', () => {
    expect(stepOrderRespectsInvariant(['persist', 'validate'])).toBe(false)
    expect(stepOrderRespectsInvariant(['validate', 'persist'])).toBe(true)
    expect(stepOrderRespectsInvariant(['persist'])).toBe(false)
    expect(stepOrderRespectsInvariant(['validate'])).toBe(false)
  })
})
