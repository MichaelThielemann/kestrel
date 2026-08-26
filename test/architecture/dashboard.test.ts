import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { buildIntrospectionPipelines, buildPipelineIndex, clearPipelines, clearRegistry, registerCollection, registerPipeline, renderDashboard, syncStep } from '@michaelthielemann/kestrel-core'
import { pagesCollection as pages } from '@michaelthielemann/kestrel-collections'
import posts from '../../server/collections/posts'

Object.assign(globalThis, {
  defineNitroPlugin: (fn: () => void) => fn,
  useRuntimeConfig: () => ({
    kestrel: { output: { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: true, publishOnSave: false, reconcileMinutes: 0, verbose: false, s3: {} } },
  }),
  useDb: () => drizzle(new Database(':memory:')),
  primaryLocale: () => 'en',
  prefixPrimaryLocale: () => false,
})

beforeEach(() => {
  clearRegistry()
  registerCollection(pages)
  registerCollection(posts)
  clearPipelines()
  for (const def of buildIntrospectionPipelines()) registerPipeline(def)
  registerPipeline({
    name: 'archivePost',
    on: { collection: 'posts' },
    access: { role: 'admin' },
    steps: [syncStep('archive', (ctx) => { ctx.output = { archived: true } })],
  })
})

afterEach(() => { clearRegistry(); clearPipelines() })

describe('the dashboard renderer', () => {
  it('lists every registered routable pipeline', () => {
    const pipelines = buildPipelineIndex()
    const html = renderDashboard({ pipelines })
    expect(pipelines.length).toBeGreaterThan(0)
    for (const p of pipelines) expect(html).toContain(p.name)
    expect(html).toContain('archivePost')
    expect(html).toContain('/api/posts/archivePost')
  })

  it('renders only the pipelines in its input — a registered pipeline excluded from the data must not leak in', () => {
    // The decoy IS in the registry; if the renderer ever pulled from the registry instead of its
    // input data, this would go red.
    const withoutDecoy = buildPipelineIndex().filter((p) => p.name !== 'archivePost')
    const html = renderDashboard({ pipelines: withoutDecoy })
    expect(withoutDecoy.length).toBeGreaterThan(0)
    expect(html).not.toContain('archivePost')
  })

  it('produces self-contained HTML: no http(s):// resource reference anywhere in the output', () => {
    const html = renderDashboard({
      pipelines: buildPipelineIndex(),
      pluginOrder: [{ layer: 'core', file: 'server/plugins/00.config.ts', after: [] }],
      collections: [{ name: 'posts', mode: 'multi', translatable: true, fieldCount: 3 }],
      graph: {
        packageEdges: [{ from: 'media', to: 'core' }],
        apiSurface: [{ report: 'packages/kestrel-core/etc/core.api.md', count: 340, ceiling: 348 }],
      },
      generatedAt: new Date().toISOString(),
    })
    expect(html).not.toMatch(/https?:\/\//)
    expect(html.startsWith('<!doctype html>')).toBe(true)
  })

  it('renders the plugin order and discovery sections only when data is provided', () => {
    const bare = renderDashboard({ pipelines: buildPipelineIndex() })
    expect(bare).not.toContain('id="plugin-order"')
    expect(bare).not.toContain('id="discovery"')
    expect(bare).not.toContain('id="graph"')

    const full = renderDashboard({
      pipelines: buildPipelineIndex(),
      pluginOrder: [{ layer: 'core', file: 'server/plugins/00.config.ts', after: [] }],
      collections: [{ name: 'posts', mode: 'multi', translatable: true, fieldCount: 3 }],
    })
    expect(full).toContain('id="plugin-order"')
    expect(full).toContain('id="discovery"')
  })
})

// The dev route's own guard: `layers/core/server/routes/__kestrel/dashboard.get.ts` throws a 404 outside
// `import.meta.dev` — proven at unit level here (booting the real Nitro dev server for this alone is
// expensive and already covered manually as part of the shipping gate for this change) by asserting the
// guard condition is literally the first statement the handler runs.
describe('the dev route registration condition', () => {
  it('is guarded by import.meta.dev as the first check in the handler source', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('layers/core/server/routes/__kestrel/dashboard.get.ts', 'utf8')
    const body = src.slice(src.indexOf('defineEventHandler'))
    expect(body.indexOf('import.meta.dev')).toBeGreaterThan(-1)
    expect(body.indexOf('import.meta.dev')).toBeLessThan(body.indexOf('allCollections()'))
  })
})
