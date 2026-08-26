import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { WRITE_OPS, allCollections, buildPipelineIndex, clearPipelines, clearRegistry, defaultCollectionOps, registerCollection } from '@michaelthielemann/kestrel-core'
import type { PipelineDescriptor } from '@michaelthielemann/kestrel-core'
import { pagesCollection as pages } from '@michaelthielemann/kestrel-collections'
import posts from '../../server/collections/posts'
import settings from '../../server/collections/settings'
import { mediaCollection as media, mediaSettingsCollection as mediaSettings } from '@michaelthielemann/kestrel-media'
import { redirectsCollection as redirects, siteCollection as site } from '@michaelthielemann/kestrel-publishing'

/**
 * Boots the real registered-after-step plugins (not a parallel description) the same way
 * layers/public/server/plugins/zz.publish.test.ts does: `defineNitroPlugin` faked to a passthrough so
 * each plugin module's default export is callable directly, no Nitro boot required.
 */
Object.assign(globalThis, {
  defineNitroPlugin: (fn: () => void) => fn,
  useRuntimeConfig: () => ({
    kestrel: { output: { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: true, publishOnSave: false, reconcileMinutes: 0, verbose: false, s3: {} } },
  }),
  useDb: () => drizzle(new Database(':memory:')),
  primaryLocale: () => 'en',
  prefixPrimaryLocale: () => false,
})

const ADR_DOC = readFileSync(join(process.cwd(), 'docs/internals/decisions.md'), 'utf-8')

let index: PipelineDescriptor[]

beforeAll(async () => {
  clearRegistry()
  registerCollection(pages)
  registerCollection(posts)
  registerCollection(settings)
  registerCollection(media)
  registerCollection(mediaSettings)
  registerCollection(redirects)
  registerCollection(site)

  clearPipelines()
  const redirectsPlugin = (await import('../../layers/public/server/plugins/03.redirects')).default as unknown as () => void
  const publishPlugin = (await import('../../layers/public/server/plugins/zz.publish')).default as unknown as () => void
  redirectsPlugin()
  // zz.publish's boot enqueue starts a debounce timer; fake timers keep it from ever firing a real render.
  vi.useFakeTimers()
  publishPlugin()
  vi.useRealTimers()

  index = buildPipelineIndex()
})

afterAll(() => {
  clearRegistry()
  clearPipelines()
})

const isWriteOp = (name: string): boolean => (WRITE_OPS as readonly string[]).includes(name)
const writePipelines = (): PipelineDescriptor[] => index.filter((p) => isWriteOp(p.name))

describe('pipeline invariants', () => {
  it('composes a non-empty index covering every registered collection', () => {
    expect(index.length).toBeGreaterThan(0)
    const collections = new Set(index.map((p) => p.collection))
    for (const name of ['pages', 'posts', 'settings', 'media', 'media_settings', 'redirects', 'site']) {
      expect(collections).toContain(name)
    }
    expect(writePipelines().length).toBeGreaterThan(0)
  })

  // deleteOne/deleteMany carry no create/update body, so they have nothing to validate — every other
  // standard write op does.
  const VALIDATING_WRITE_OPS = new Set(['createOne', 'createMany', 'updateOne', 'updateMany'])

  it('every write pipeline reaches persist only after validate', () => {
    for (const p of writePipelines()) {
      if (!VALIDATING_WRITE_OPS.has(p.name)) continue
      const names = p.steps.map((s) => s.name)
      const validateAt = names.indexOf('validate')
      const persistAt = names.indexOf('persist')
      expect(validateAt, `${p.collection}/${p.name}: no "validate" step`).toBeGreaterThanOrEqual(0)
      expect(persistAt, `${p.collection}/${p.name}: no "persist" step`).toBeGreaterThanOrEqual(0)
      expect(validateAt, `${p.collection}/${p.name}: "validate" must precede "persist"`).toBeLessThan(persistAt)
    }
  })

  it('every write pipeline has emitEvents after persist', () => {
    for (const p of writePipelines()) {
      const names = p.steps.map((s) => s.name)
      const persistAt = names.indexOf('persist')
      const emitAt = names.indexOf('emitEvents')
      expect(persistAt, `${p.collection}/${p.name}: no "persist" step`).toBeGreaterThanOrEqual(0)
      expect(emitAt, `${p.collection}/${p.name}: no "emitEvents" step after persist`).toBeGreaterThan(persistAt)
    }
  })

  it('every expected pipeline is composed with an access gate', () => {
    // A missing `access` makes `isRoutablePipeline` drop the pipeline from the index entirely (the engine
    // refuses to run it) — so the regression to catch is the op silently VANISHING, not an entry with a
    // null gate. Checking presence against the expected (collection, op) set is what makes that visible.
    for (const collection of allCollections()) {
      for (const op of defaultCollectionOps()) {
        const p = index.find((entry) => entry.collection === collection.name && entry.name === op)
        expect(p, `${collection.name}/${op}: missing from the composed index — an access gate may be absent`).toBeDefined()
        expect(p!.gates.access, `${collection.name}/${op}: no access gate`).not.toBeNull()
      }
    }
  })

  it('no write pipeline descriptor lists an after-step named "reindexRefs" (moved to an outbox handler)', () => {
    for (const p of index) {
      expect(p.after.some((a) => a.name === 'reindexRefs'), `${p.collection}/${p.name}: still lists "reindexRefs" as an after-step`).toBe(false)
    }
  })

  it('every critical after-step is named in an ADR- section of docs/internals/decisions.md', () => {
    const criticalNames = new Set<string>()
    for (const p of index) {
      for (const a of p.after) if (a.critical) criticalNames.add(a.name)
    }
    // Today that is exactly `writeRedirects` (ADR-0009) — asserted as a floor so this test cannot pass
    // vacuously on an empty set; a newly added, properly documented critical step only grows the set.
    expect(criticalNames.has('writeRedirects'), 'expected the known critical after-step "writeRedirects" (ADR-0009)').toBe(true)
    const adrSections = ADR_DOC.split(/^## ADR-/m).slice(1)
    for (const name of criticalNames) {
      const mentioned = adrSections.some((section) => section.includes(name))
      expect(mentioned, `critical after-step "${name}" is not documented in an ADR- section`).toBe(true)
    }
  })

  it('ADR-0010: no non-sync step sits between the first and last sync step of a composed write pipeline', () => {
    for (const p of writePipelines()) {
      const syncIndexes = p.steps.reduce<number[]>((acc, s, i) => { if (s.sync) acc.push(i); return acc }, [])
      if (syncIndexes.length === 0) continue
      const first = syncIndexes[0]!
      const last = syncIndexes[syncIndexes.length - 1]!
      for (let i = first + 1; i < last; i++) {
        expect(p.steps[i]!.sync, `${p.collection}/${p.name}: step "${p.steps[i]!.name}" at index ${i} is not sync but sits inside the critical section [${first}, ${last}] (ADR-0010)`).toBe(true)
      }
    }
  })
})
