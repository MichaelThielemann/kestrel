// Deterministic static dashboard generator — no network. Boots the pipeline/collection registries
// the same way test/architecture/pipeline-invariants.test.ts does (no Nuxt boot needed for that), then
// renders through the SAME renderDashboard() the dev route uses, so the two surfaces never drift.
//
// Run with: npx tsx scripts/dashboard.mjs   (or `pnpm dashboard`)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { fieldTypes } from '@kestrel/fields'
import {
  buildIntrospectionPipelines, buildPipelineIndex, clearPipelines, clearRegistry,
  registerCollection, registerPipeline, renderDashboard, setResolvedKestrelConfig, allCollections,
} from '@kestrel/core'
import { buildAuthPipelines } from '@kestrel/auth'
import { pagesCollection } from '@kestrel/collections'
import { mediaCollection, mediaSettingsCollection } from '@kestrel/media'
import { redirectsCollection, siteCollection } from '@kestrel/publishing'
import { resolveServerKestrelConfig } from '../layers/core/server/utils/server-config.ts'
import { PLUGIN_ORDER } from '../layers/core/modules/plugin-order/plugin-order.ts'
import posts from '../server/collections/posts.ts'
import settings from '../server/collections/settings.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

void fieldTypes
setResolvedKestrelConfig(resolveServerKestrelConfig())
Object.assign(globalThis, {
  useRuntimeConfig: () => ({
    kestrel: { output: { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: true, publishOnSave: false, reconcileMinutes: 0, verbose: false, s3: {} } },
  }),
  useDb: () => drizzle(new Database(':memory:')),
  primaryLocale: () => 'en',
  prefixPrimaryLocale: () => false,
})

clearRegistry()
for (const c of [pagesCollection, posts, settings, mediaCollection, mediaSettingsCollection, redirectsCollection, siteCollection]) registerCollection(c)

clearPipelines()
for (const def of buildAuthPipelines()) registerPipeline(def)
for (const def of buildIntrospectionPipelines()) registerPipeline(def)

const collections = allCollections().map((c) => ({
  name: c.name,
  mode: c.def.mode,
  translatable: Boolean(c.def.translatable),
  fieldCount: Object.keys(c.def.fields).length,
}))

/** Reads a repo-only enrichment file, or returns undefined — a consumer project (or a fresh checkout
 *  before `graphify update`/`pnpm api:check` have run) ships none of these, so every read is optional. */
function readJsonIfExists(relPath) {
  const abs = join(repoRoot, relPath)
  if (!existsSync(abs)) return undefined
  return JSON.parse(readFileSync(abs, 'utf8'))
}

function apiSurfaceSection() {
  const ceilings = readJsonIfExists('test/architecture/public-api-ceilings.json')
  if (!ceilings) return undefined
  const out = []
  for (const [report, ceiling] of Object.entries(ceilings)) {
    const abs = join(repoRoot, report)
    if (!existsSync(abs)) continue
    const count = readFileSync(abs, 'utf8').split('\n').filter((l) => /^\/\/ @(public|alpha|beta|internal)\b/.test(l)).length
    out.push({ report, count, ceiling })
  }
  return out
}

const edgeAllowlist = readJsonIfExists('test/architecture/edge-allowlist.json')
const apiSurface = apiSurfaceSection()

const html = renderDashboard({
  pipelines: buildPipelineIndex(),
  pluginOrder: PLUGIN_ORDER.map((p) => ({ layer: p.layer, file: p.file, after: p.after })),
  collections,
  graph: (edgeAllowlist || apiSurface) ? { packageEdges: edgeAllowlist?.edges, apiSurface } : undefined,
  generatedAt: new Date().toISOString(),
})

const outDir = join(repoRoot, 'docs')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'dashboard.html')
writeFileSync(outFile, html)
console.log(`[dashboard] wrote ${outFile} (${buildPipelineIndex().length} pipelines, ${collections.length} collections)`)
