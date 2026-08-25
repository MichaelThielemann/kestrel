/**
 * Graph half of per-module ownership (ADR-0012): the negative/reach halves live in
 * `ownership.{media,content,publishing}.test.ts` (adapter-level, runtime). This file asserts the same
 * property from the static import graph — no file outside a module's own file set imports that module's
 * table object — for the modules/tables the graph can actually see.
 *
 * WHAT THE GRAPH CAN AND CANNOT SEE (honesty rule): graphify extracts `import`/`references` edges between
 * source symbols. A table object (a `sqliteTable(...)` export) is one such symbol, so "does file X import
 * module Y's table object" is directly observable. What is NOT observable this way: a raw SQL string
 * naming a table (`db.prepare('SELECT * FROM record_refs')`), which is exactly what the adapter's own
 * `module-db.ts` scans for at runtime and what `ownership.*.test.ts` already exercises. This file therefore
 * only asserts the import-graph half of ownership; the raw-SQL half stays covered by the adapter tests,
 * not duplicated here.
 *
 * MODULE FILE SETS (documented, not inferred):
 * - media: `packages/kestrel-media/src/**` (the server domain, now a package) + `layers/media/**` (the
 *   remaining app-side layer plus the thin Nitro plugin/middleware/task wiring) — together, the module.
 * - publishing: `packages/kestrel-publishing/src/**` (the tables/manifest/publishing-db adapter, now a
 *   package) + `layers/public/server/**` (the remaining layer wiring — pipelines, plugins,
 *   utils/publish/*, schema-tables/ shims). Includes `pipelines/publish.ts` and `schema-tables/`, both
 *   legitimate owners, not just `utils/publish/` + `db/` as a first approximation might suggest.
 * - content: for THIS file, scoped to `record_refs` only — `layers/core/**`. Content's other tables are
 *   per-collection and registered dynamically (`defineCollection` at consumer boot), so they have no
 *   static table-object export for the graph to see; the adapter/runtime tests
 *   (`ownership.content.test.ts`, `derived-rebuild.test.ts`) are the only mechanism that can observe those.
 *   `record_refs` itself is not content-domain-exclusive within `layers/core` — the core pipeline/schema
 *   machinery (write-path after-steps, schema bootstrap) legitimately touches it too — so the check is
 *   "not touched by media or publishing", not "touched only by a content sub-directory".
 *
 * Global exemptions: `server/database/schema.ts`/`.test.ts` (the full-schema aggregator, which legitimately
 * imports every table by design) and `test/architecture/**` (the ownership/reach/rebuild tests themselves,
 * which deliberately import foreign tables to prove the adapter rejects them).
 *
 * Coverage matrix (module x {negative test, reach test, graph assertion}):
 *
 * | module     | adapter negative test (OwnershipViolation) | real-path reach test        | graph import-scan (this file) |
 * |------------|----------------------------------------------|------------------------------|--------------------------------|
 * | media      | ownership.media.test.ts                       | ownership.media.test.ts       | yes — media, media_settings, folders |
 * | publishing | ownership.publishing.test.ts                  | ownership.publishing.test.ts  | yes — publish_deps, publish_status |
 * | content    | ownership.content.test.ts                     | ownership.content.test.ts     | yes — record_refs only (dynamic collection tables out of static reach, see above) |
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

interface GraphNode {
  id: string
  source_file?: string
}

interface GraphLink {
  relation: string
  confidence?: string
  source: string
  target: string
}

interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
}

const graph: Graph = JSON.parse(readFileSync(resolve(root, 'graphify-out/graph.json'), 'utf8'))
const nodesById = new Map(graph.nodes.map(n => [n.id, n]))

// Mirrors layer-edges.test.ts's DEPENDENCY_RELATIONS/confidence filter exactly, for the same reasons
// (auto-imports leave no `import` statement; `indirect_call` is a low-confidence name-match heuristic).
const DEPENDENCY_RELATIONS = new Set([
  'imports',
  'imports_from',
  'calls',
  'dynamic_import',
  're_exports',
  'extends',
  'inherits',
  'references',
])

interface TableCheck {
  readonly module: string
  readonly table: string
  readonly nodeId: string
  readonly ownedPrefixes: readonly string[]
  /** A known incoming edge that must survive, so a graph-schema/id-scheme drift fails loud, not silently empty. */
  readonly anchorSourceFile: string
}

const TABLE_CHECKS: readonly TableCheck[] = [
  { module: 'media', table: 'media', nodeId: 'packages_kestrel_media_src_server_collections_media_media', ownedPrefixes: ['packages/kestrel-media/', 'layers/media/'], anchorSourceFile: 'packages/kestrel-media/src/server/db/media-db.ts' },
  { module: 'media', table: 'media_settings', nodeId: 'packages_kestrel_media_src_server_collections_media_settings_mediasettings', ownedPrefixes: ['packages/kestrel-media/', 'layers/media/'], anchorSourceFile: 'packages/kestrel-media/src/server/db/media-db.ts' },
  { module: 'media', table: 'folders', nodeId: 'packages_kestrel_media_src_server_database_folders_folders', ownedPrefixes: ['packages/kestrel-media/', 'layers/media/'], anchorSourceFile: 'packages/kestrel-media/src/server/db/media-db.ts' },
  { module: 'publishing', table: 'publish_deps', nodeId: 'packages_kestrel_publishing_src_server_database_publish_deps_publishdeps', ownedPrefixes: ['packages/kestrel-publishing/', 'layers/public/server/'], anchorSourceFile: 'packages/kestrel-publishing/src/server/db/publishing-db.ts' },
  { module: 'publishing', table: 'publish_status', nodeId: 'packages_kestrel_publishing_src_server_database_publish_status_publishstatus', ownedPrefixes: ['packages/kestrel-publishing/', 'layers/public/server/'], anchorSourceFile: 'packages/kestrel-publishing/src/server/db/publishing-db.ts' },
  { module: 'content', table: 'record_refs', nodeId: 'packages_kestrel_core_src_server_database_record_refs_recordrefs', ownedPrefixes: ['packages/kestrel-core/'], anchorSourceFile: 'packages/kestrel-core/src/server/db/content-manifest.ts' },
]

// A schema change in graph.json (renamed `source_file`/`source`/`target`/`relation`/`confidence` fields,
// or a re-generated id scheme) would make every lookup below return nothing — and then "no foreign
// touches found" would pass vacuously on zero edges. This floor + the per-table anchor assertion fail
// loud on that instead of silently proving nothing.
//
// 2, not 3: publish_deps/publish_status only have ONE direct relative-import consumer inside
// their own package (publishing-db.ts) plus the package barrel's own re-export edge — every consumer
// outside the package reaches the table through the `@kestrel/publishing` bare specifier, which the graph
// resolves to the BARREL node (index.ts), not transitively through to the deep table symbol. media's
// folders (8 edges) differs because several of ITS OWN internal files import the table via a relative
// path, not because of any drift here — the floor is the honest minimum for a package whose external
// consumers are barrel-only, still non-zero and still anchor-checked below.
const MIN_INCOMING_EDGES_PER_TABLE = 2

const EXEMPT_FILE_RE = /^(?:test\/architecture\/|server\/database\/schema\.ts$|server\/database\/schema\.test\.ts$)/

function isOwned(sourceFile: string, ownedPrefixes: readonly string[]): boolean {
  return ownedPrefixes.some(p => sourceFile.startsWith(p))
}

describe('module ownership — graph rail (ADR-0012)', () => {
  it.each(TABLE_CHECKS)('$module\'s $table table exists in the graph with importers (schema sanity)', ({ nodeId, anchorSourceFile }) => {
    expect(nodesById.has(nodeId), `table node ${nodeId} missing from graph.json — id scheme drift?`).toBe(true)

    const incoming = graph.links.filter(l =>
      l.target === nodeId && DEPENDENCY_RELATIONS.has(l.relation) && l.confidence === 'EXTRACTED',
    )
    expect(incoming.length).toBeGreaterThanOrEqual(MIN_INCOMING_EDGES_PER_TABLE)

    const anchored = incoming.some(l => nodesById.get(l.source)?.source_file === anchorSourceFile)
    expect(anchored, `expected stable anchor importer ${anchorSourceFile} for ${nodeId}`).toBe(true)
  })

  it.each(TABLE_CHECKS)('no file outside the $module module imports the $table table object', ({ nodeId, ownedPrefixes, module, table }) => {
    const incoming = graph.links.filter(l =>
      l.target === nodeId && DEPENDENCY_RELATIONS.has(l.relation) && l.confidence === 'EXTRACTED',
    )

    const violations = incoming
      .map(l => nodesById.get(l.source)?.source_file)
      .filter((sourceFile): sourceFile is string => sourceFile !== undefined)
      .filter(sourceFile => !EXEMPT_FILE_RE.test(sourceFile))
      .filter(sourceFile => !isOwned(sourceFile, ownedPrefixes))

    expect(violations, `foreign import of ${module}'s ${table} table: ${violations.join(', ')}`).toEqual([])
  })
})
