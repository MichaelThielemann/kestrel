import type { PipelineDescriptor } from '../pipeline/introspect.js'

/** One `layers/core/modules/plugin-order`-shaped entry — kept structural here rather than importing that
 *  module (a Nuxt-module-only file, outside kestrel-core's own dependency direction).
 * @public */
export interface DashboardPluginOrderEntry {
  layer: string
  file: string
  after: string[]
}

/** One registered collection, summarized for the discovery section.
 * @public */
export interface DashboardCollectionSummary {
  name: string
  mode: string
  fieldCount: number
  translatable: boolean
}

/** Package dependency edges and API-surface counts — present only when the repo-only edge-allowlist
 *  and api-extractor reports were found (a consumer project ships none of them).
 * @public */
export interface DashboardGraphSection {
  packageEdges?: { from: string, to: string, debt?: boolean }[]
  apiSurface?: { report: string, count: number, ceiling: number }[]
}

/** Plain data input to {@link renderDashboard} — gathered live by the dev route from the registry, or by
 *  `scripts/dashboard.mjs` by booting the registry the same way the architecture tests do. No section
 *  reaches into a registry or the filesystem itself: the renderer is pure so both callers share one output.
 * @public
 */
export interface DashboardData {
  pipelines: PipelineDescriptor[]
  pluginOrder?: DashboardPluginOrderEntry[]
  collections?: DashboardCollectionSummary[]
  graph?: DashboardGraphSection
  /** ISO timestamp, shown in the footer so a stale static file is obviously stale. */
  generatedAt?: string
}

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function chain(names: string[]): string {
  if (names.length === 0) return '<span class="muted">(none)</span>'
  return names.map((n) => `<span class="step">${esc(n)}</span>`).join('<span class="arrow">&rarr;</span>')
}

function renderPipelineRow(p: PipelineDescriptor): string {
  const stepNames = p.steps.map((s) => s.sealed ? `${s.name}*` : s.name)
  const afterNames = p.after.map((a) => a.critical ? `${a.name}!` : a.name)
  const access = p.gates.access ? esc(JSON.stringify(p.gates.access)) : '<span class="muted">(none)</span>'
  return `<tr>
    <td>${esc(p.collection ?? '—')}</td>
    <td><code>${esc(p.name)}</code>${p.ui ? ' <span class="badge">action</span>' : ''}</td>
    <td><span class="method method-${p.route.method}">${p.route.method}</span> <code>${esc(p.route.url)}</code></td>
    <td>${chain(stepNames)}</td>
    <td>${afterNames.length ? chain(afterNames) : '<span class="muted">(none)</span>'}</td>
    <td>${access}${p.gates.csrf ? ' <span class="badge">csrf</span>' : ''}${p.gates.ipAllowlist ? ' <span class="badge">ip-allowlist</span>' : ''}</td>
  </tr>`
}

function renderPipelinesSection(pipelines: PipelineDescriptor[]): string {
  const rows = pipelines.map(renderPipelineRow).join('\n')
  return `<section id="pipelines">
    <h2>API endpoints &amp; pipelines</h2>
    <p class="muted">${pipelines.length} routable pipeline${pipelines.length === 1 ? '' : 's'} — the URL grammar is
      <code>GET /api/&lt;collection&gt;/&lt;readPipeline&gt;[/&lt;id&gt;]</code>,
      <code>POST /api/&lt;collection&gt;/&lt;writePipeline&gt;[/&lt;id&gt;]</code>, or
      <code>POST /api/&lt;pipeline&gt;</code> for a collection-less one. <code>*</code> marks a sealed step,
      <code>!</code> marks a critical after-step.</p>
    <table>
      <thead><tr><th>Collection</th><th>Pipeline</th><th>Route</th><th>Steps</th><th>After</th><th>Gates</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`
}

function renderPluginOrderSection(entries: DashboardPluginOrderEntry[]): string {
  const rows = entries.map((e, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td>${esc(e.layer)}</td>
    <td><code>${esc(e.file)}</code></td>
    <td>${e.after.length ? chain(e.after) : '<span class="muted">(none)</span>'}</td>
  </tr>`).join('\n')
  return `<section id="plugin-order">
    <h2>Plugin boot order</h2>
    <p class="muted">Declared execution order for Kestrel's own <code>server/plugins/**</code>, replacing Nitro's
      layer-then-filename scan. "After" lists the entries this one depends on running first.</p>
    <table>
      <thead><tr><th>#</th><th>Layer</th><th>File</th><th>After</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`
}

function renderDiscoverySection(collections: DashboardCollectionSummary[]): string {
  const rows = collections.map((c) => `<tr>
    <td><code>${esc(c.name)}</code></td>
    <td>${esc(c.mode)}</td>
    <td>${c.translatable ? 'yes' : 'no'}</td>
    <td class="num">${c.fieldCount}</td>
  </tr>`).join('\n')
  return `<section id="discovery">
    <h2>Discovery</h2>
    <p class="muted">${collections.length} collection${collections.length === 1 ? '' : 's'} registered in this
      process — built-ins and packages merged with the consumer's own <code>server/collections/*.ts</code>.</p>
    <table>
      <thead><tr><th>Collection</th><th>Mode</th><th>Translatable</th><th>Fields</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`
}

function renderGraphSection(graph: DashboardGraphSection): string {
  const edgeRows = (graph.packageEdges ?? []).map((e) => `<tr>
    <td>${esc(e.from)}</td><td>${esc(e.to)}</td><td>${e.debt ? '<span class="badge badge-warn">debt</span>' : ''}</td>
  </tr>`).join('\n')
  const surfaceRows = (graph.apiSurface ?? []).map((s) => {
    const over = s.count > s.ceiling
    return `<tr class="${over ? 'over' : ''}">
      <td><code>${esc(s.report)}</code></td>
      <td class="num">${s.count}</td>
      <td class="num">${s.ceiling}</td>
      <td>${over ? '<span class="badge badge-warn">over ceiling</span>' : 'ok'}</td>
    </tr>`
  }).join('\n')
  const edgesBlock = edgeRows
    ? `<h3>Layer dependency edges (allowlisted)</h3>
       <table><thead><tr><th>From</th><th>To</th><th></th></tr></thead><tbody>${edgeRows}</tbody></table>`
    : ''
  const surfaceBlock = surfaceRows
    ? `<h3>Public API surface vs. ceiling</h3>
       <table><thead><tr><th>Report</th><th>Count</th><th>Ceiling</th><th></th></tr></thead><tbody>${surfaceRows}</tbody></table>`
    : ''
  if (!edgesBlock && !surfaceBlock) return ''
  return `<section id="graph">
    <h2>Graph enrichment</h2>
    ${edgesBlock}
    ${surfaceBlock}
  </section>`
}

const STYLE = `
:root { color-scheme: light dark; --bg: #0f1115; --fg: #e4e7eb; --muted: #8a8f98; --border: #2a2e37; --accent: #6ea8fe; --get: #2e7d32; --post: #b26a00; --warn: #b3261e; }
@media (prefers-color-scheme: light) { :root { --bg: #ffffff; --fg: #1b1e24; --muted: #5b6270; --border: #dde1e8; --accent: #2456c9; --get: #1e7d34; --post: #9a5b00; --warn: #b3261e; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.15rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35rem; margin-top: 2.5rem; }
h3 { font-size: 1rem; margin-top: 1.5rem; }
.muted { color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.over { background: color-mix(in srgb, var(--warn) 12%, transparent); }
.step { display: inline-block; padding: 0.05rem 0.4rem; border: 1px solid var(--border); border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.85em; }
.arrow { color: var(--muted); margin: 0 0.15rem; }
.badge { display: inline-block; font-size: 0.72em; padding: 0.05rem 0.35rem; border-radius: 3px; background: var(--accent); color: #fff; margin-left: 0.3rem; }
.badge-warn { background: var(--warn); }
.method { font-weight: 700; font-size: 0.8em; padding: 0.05rem 0.3rem; border-radius: 3px; }
.method-GET { color: var(--get); border: 1px solid var(--get); }
.method-POST { color: var(--post); border: 1px solid var(--post); }
footer { margin-top: 3rem; color: var(--muted); font-size: 0.8em; }
nav a { color: var(--accent); text-decoration: none; margin-right: 1rem; }
`

/**
 * Renders a self-contained dashboard HTML page from plain data — no registry access, no filesystem reads,
 * no network requests in the output. Both the `/__kestrel/dashboard` dev route and `scripts/dashboard.mjs`
 * gather their own `DashboardData` and call this the same way, so the two surfaces never drift apart.
 * @public
 */
export function renderDashboard(data: DashboardData): string {
  const sections = [
    renderPipelinesSection(data.pipelines),
    data.pluginOrder ? renderPluginOrderSection(data.pluginOrder) : '',
    data.collections ? renderDiscoverySection(data.collections) : '',
    data.graph ? renderGraphSection(data.graph) : '',
  ].filter(Boolean).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kestrel dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Kestrel introspection dashboard</h1>
<p class="muted">Deterministic, generated from machine-readable sources.</p>
<nav>
  <a href="#pipelines">Pipelines</a>
  ${data.pluginOrder ? '<a href="#plugin-order">Plugin order</a>' : ''}
  ${data.collections ? '<a href="#discovery">Discovery</a>' : ''}
  ${data.graph ? '<a href="#graph">Graph</a>' : ''}
</nav>
${sections}
<footer>${data.generatedAt ? `Generated ${esc(data.generatedAt)}` : ''}</footer>
</body>
</html>`
}
