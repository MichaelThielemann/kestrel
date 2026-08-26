import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()

/** Every `@kestrel/*` workspace package with a `src/` dir — computed from `packages/*` on disk, so a new
 *  extraction (or `create-kestrel`, which has neither a `src/` dir nor an `@kestrel/*` name) needs no
 *  edit here. */
function kestrelPackageDirs(): Array<{ name: string; dir: string }> {
  const base = resolve(root, 'packages')
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => resolve(base, e.name))
    .filter((dir) => existsSync(join(dir, 'src')))
    .map((dir) => ({ name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name as string, dir }))
    .filter((p) => p.name.startsWith('@kestrel/'))
}

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

interface AllowlistEntry {
  from: string
  to: string
  debt?: boolean
}

interface Allowlist {
  edges: AllowlistEntry[]
}

const graphPath = resolve(root, 'graphify-out/graph.json')
const graphExists = existsSync(graphPath)
const graph: Graph = graphExists ? JSON.parse(readFileSync(graphPath, 'utf8')) : { nodes: [], links: [] }
const allowlist: Allowlist = JSON.parse(readFileSync(resolve(root, 'test/architecture/edge-allowlist.json'), 'utf8'))

const LAYER_RE = /^layers\/([a-z]+)\//
const TEST_FILE_RE = /\.test\.ts$/

// Auto-imports leave no `import` statement, so `calls`/`references`/etc. are the only trace of those
// edges. `indirect_call` is a low-confidence heuristic (matches by bare function name across files) and
// produces false positives — excluded. Everything kept here is graphify's EXTRACTED confidence tier.
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

function layerOf(sourceFile: string | undefined): string | undefined {
  if (!sourceFile) return undefined
  return LAYER_RE.exec(sourceFile)?.[1]
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`
}

const nodesById = new Map(graph.nodes.map(n => [n.id, n]))

const crossLayerEdges = new Map<string, { from: string, to: string }>()

for (const link of graph.links) {
  if (!DEPENDENCY_RELATIONS.has(link.relation)) continue
  if (link.confidence !== 'EXTRACTED') continue

  const source = nodesById.get(link.source)
  const target = nodesById.get(link.target)
  if (!source || !target) continue

  const sourceFile = source.source_file
  const targetFile = target.source_file
  if (TEST_FILE_RE.test(sourceFile ?? '') || TEST_FILE_RE.test(targetFile ?? '')) continue

  const from = layerOf(sourceFile)
  const to = layerOf(targetFile)
  if (!from || !to || from === to) continue

  crossLayerEdges.set(edgeKey(from, to), { from, to })
}

const allowedEdges = new Map(allowlist.edges.map(e => [edgeKey(e.from, e.to), e]))
const debtEdgeKeys = new Set(allowlist.edges.filter(e => e.debt).map(e => edgeKey(e.from, e.to)))

// The approved debt set, fixed here rather than read back from the allowlist: editing this line is the
// ADR-gated act that lets a new or removed debt tag pass. A drifted allowlist — one more, one
// fewer — must fail until someone consciously updates BOTH this reference and the ADR line.
// `core->fields` was the one approved debt edge (docs/internals/layers-and-packages.md); since paid off —
// the registry mechanisms (field-types, blocks) and pure cores (naming, sanitize, block-ids, extract-refs,
// buildCollection) moved into core (now `packages/kestrel-core`), so core no longer imports from fields
// at all.
const APPROVED_DEBT_EDGES = new Set<string>()

// A schema change in graph.json (renamed `source_file`/`source`/`target`/`relation`/`confidence` fields)
// would make layerOf() return undefined everywhere, silently emptying crossLayerEdges — and then "every
// edge is in the allowlist" would pass on zero edges. These two checks fail loud on that instead.
// Was 15 before the fields extraction: 5 `X->fields` edges (admin/collections/media/public/ui) went
// from layer-relative imports to a package dependency (@kestrel/fields) — 10 real edges remained. The one
// remaining `public->access` edge was retired the same way (@kestrel/access) — 9 real edges remain now.
// Lowered with margin below that, not raised back to cover a count this rail is
// never going to see again.
const MIN_EXPECTED_CROSS_LAYER_EDGES = 8
const ANCHOR_EDGE = 'admin->core'

describe.skipIf(!graphExists)('layer boundaries — graph rail', () => {
  it('extraction is not silently empty (graph schema sanity)', () => {
    expect(crossLayerEdges.size).toBeGreaterThanOrEqual(MIN_EXPECTED_CROSS_LAYER_EDGES)
    expect(crossLayerEdges.has(ANCHOR_EDGE), `expected stable anchor edge ${ANCHOR_EDGE} to be present`).toBe(true)
  })

  it('every cross-layer edge in the graph is in the allowlist', () => {
    const violations = [...crossLayerEdges.values()]
      .filter(e => !allowedEdges.has(edgeKey(e.from, e.to)))
      .map(e => edgeKey(e.from, e.to))

    expect(violations, `unallowlisted cross-layer edges: ${violations.join(', ')}`).toEqual([])
  })

  it('the allowlist tags exactly the approved debt edges — no more, no fewer', () => {
    expect([...debtEdgeKeys].sort()).toEqual([...APPROVED_DEBT_EDGES].sort())
  })

  it('debt edges currently exercised in the codebase do not grow beyond the approved set', () => {
    const exercisedDebtEdges = [...crossLayerEdges.keys()].filter(key => debtEdgeKeys.has(key))

    for (const key of exercisedDebtEdges) {
      expect(APPROVED_DEBT_EDGES.has(key), `${key} is exercised but not an approved debt edge`).toBe(true)
    }

    // Reported for visibility — not a pass/fail signal beyond the containment check above.
    console.info('exercised debt edges:', exercisedDebtEdges)
  })
})

// Package-era boundary rules: layers may depend on a package (that's the whole point of the
// cut — `layers/**` importing `@kestrel/core` is expected and unrestricted, not allowlisted edge-by-edge
// the way risky cross-LAYER deps are), but never the reverse, and never by reaching past the package's
// public entry into its internals. Both are plain source scans, not graph-derived: the graph resolves a
// bare `@kestrel/core` import and a relative `packages/kestrel-core/src/...` reach-in to the SAME target
// file, so only the import SPECIFIER'S OWN TEXT (not its resolved target) can tell them apart.
function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { walkTsFiles(full, out); continue }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('package boundaries (post-cut)', () => {
  it('no package (packages/*/src/**) imports a layer', () => {
    const layerImport = /(?:from\s+|import\s*\(\s*)['"][^'"]*\/layers\//
    const offenders: string[] = []
    for (const { dir } of kestrelPackageDirs()) {
      for (const file of walkTsFiles(join(dir, 'src'))) {
        if (layerImport.test(readFileSync(file, 'utf8'))) offenders.push(file)
      }
    }
    expect(offenders, `package code importing a layer: ${offenders.join(', ')}`).toEqual([])
  })

  it('no layer file reaches past a package\'s public entry into its src by path', () => {
    // Computed from disk (kestrelPackageDirs), not hand-listed — a new extraction needs no edit here.
    const suffixes = kestrelPackageDirs().map(({ dir }) => dir.split('/').pop()!.replace(/^kestrel-/, ''))
    const reachIn = new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['"][^'"]*kestrel-(?:${suffixes.join('|')})\\/src\\/`)
    const offenders: string[] = []
    for (const dir of ['layers', 'extensions']) {
      for (const file of walkTsFiles(resolve(root, dir))) {
        if (reachIn.test(readFileSync(file, 'utf8'))) offenders.push(file)
      }
    }
    expect(
      offenders,
      `layer file reaching into a package's src by path instead of its public entry: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('no file under packages/kestrel-publishing/src/** carries a STATIC import of @kestrel/media', () => {
    // publisher.ts's own @kestrel/media need (clearVariants/saveDiscoveredVariants) is a DYNAMIC
    // `await import('@kestrel/media')` inside publishFull() specifically to avoid this — a static import
    // anywhere in this package's module-load graph would make an early-boot loader of the package barrel
    // (e.g. the pipeline registration plugin) eagerly load @kestrel/media before field types are
    // registered (a real e2e-only failure this rail now guards against). A dynamic `import(` call is
    // NOT flagged — only a static `import ... from '@kestrel/media'` clause is.
    const staticMediaImport = /(?:^|\n)\s*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]@kestrel\/media['"]/
    const offenders: string[] = []
    for (const file of walkTsFiles(resolve(root, 'packages/kestrel-publishing/src'))) {
      if (staticMediaImport.test(readFileSync(file, 'utf8'))) offenders.push(file)
    }
    expect(offenders, `static @kestrel/media import found (must be dynamic): ${offenders.join(', ')}`).toEqual([])
  })
})
