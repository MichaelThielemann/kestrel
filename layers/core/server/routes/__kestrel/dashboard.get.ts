import { allCollections, buildPipelineIndex, renderDashboard } from '@kestrel/core'
import { PLUGIN_ORDER } from '../../../modules/plugin-order/plugin-order'

/**
 * Dev-only introspection dashboard: gathers live registry state, so it reflects the CONSUMER's own
 * collections/pipelines/overrides — not a static analysis of Kestrel's own source. File-based
 * `server/routes/**` modules are compiled into production builds unconditionally, so the
 * `import.meta.dev` check below is the real guard: Nitro inlines it to `false` in production and
 * dead-code-eliminates everything past it, leaving only the 404.
 */
export default defineEventHandler((event) => {
  if (!import.meta.dev) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  const collections = allCollections().map((c) => ({
    name: c.name,
    mode: c.def.mode,
    translatable: Boolean(c.def.translatable),
    fieldCount: Object.keys(c.def.fields).length,
  }))
  const html = renderDashboard({
    pipelines: buildPipelineIndex(),
    pluginOrder: PLUGIN_ORDER.map((p) => ({ layer: p.layer, file: p.file, after: p.after })),
    collections,
    generatedAt: new Date().toISOString(),
  })
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  return html
})
