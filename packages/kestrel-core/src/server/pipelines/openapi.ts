import { getRequestHeader, setResponseHeader } from 'h3'
import { Effect } from 'effect'
import { definePipeline } from '../pipeline/define.js'
import { buildOpenApiDocument } from '../pipeline/openapi.js'
import { syncStep, type PipelineDef, type StepDef } from '../pipeline/types.js'

/** A minimal, self-contained viewer: no CDN script, no new runtime dependency (none of the Scalar/Swagger
 *  packages are on `docs/internals/releasing.md` § Dependency allowlist). It re-fetches the same endpoint with an
 *  explicit `Accept: application/json` and renders the raw document — a human-readable index, not a full
 *  API-reference UI. */
function renderUiPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Kestrel API</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; margin: 2rem; color: #1a1a1a; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f5f5f5; padding: 1rem; border-radius: 4px; }
  h1 { font-size: 1.2rem; }
</style>
</head>
<body>
<h1>Kestrel OpenAPI document</h1>
<pre id="doc">Loading…</pre>
<script>
fetch(location.pathname, { headers: { accept: 'application/json' } })
  .then((res) => res.json())
  .then((doc) => { document.getElementById('doc').textContent = JSON.stringify(doc, null, 2) })
  .catch((err) => { document.getElementById('doc').textContent = 'Failed to load: ' + err })
</script>
</body>
</html>`
}

const serveOpenApiDocument: StepDef = syncStep('serveOpenApiDocument', (ctx) => Effect.sync(() => {
  const event = ctx.ports.event
  // A browser's default `Accept` prefers `text/html`; every programmatic caller (fetch/curl default,
  // and the contract test) sends `*/*` and gets the document itself — content negotiation on one
  // endpoint, not a second route, keeps the pipeline URL grammar (`_openapi` is the only new path).
  if (event && (getRequestHeader(event, 'accept') ?? '').includes('text/html')) {
    setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
    ctx.output = renderUiPage()
    return
  }
  ctx.output = buildOpenApiDocument()
}))

/** `_openapi` mirrors `_pipelines`: a non-collection, admin-only read that composes its document from the
 * @public
 *  live registry on every request. */
export function buildOpenApiPipelines(): PipelineDef[] {
  return [definePipeline({ name: '_openapi', read: true, access: { role: 'admin' }, steps: [serveOpenApiDocument] })]
}
