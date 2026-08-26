import { Effect } from 'effect'
import { definePipeline } from '../pipeline/define.js'
import { readDeadLetters } from '../db/outbox.js'
import { useDb } from '@michaelthielemann/kestrel-core'
import { syncStep, type PipelineDef, type StepDef } from '../pipeline/types.js'

/** Hard-coded to `content` — the only module with an outbox table (see `04.outbox-worker.ts`'s own note).
 *  Extend both together if a second module gets one. */
const OUTBOX_MODULE = 'content'

const listDeadLetters: StepDef = syncStep('listDeadLetters', (ctx) => Effect.sync(() => {
  ctx.output = { data: readDeadLetters(useDb(), OUTBOX_MODULE) }
}))

/** Collection-less read: everything the outbox worker gave up on. `resource: '_outbox/dead'` follows the
 *  same `<namespace>/<tool>` shape the built-in tooling reads use (`defaults.ts`'s per-collection
 *  `options`/`schema`/etc.), scoped under a `_outbox` pseudo-namespace since this isn't a real collection.
 *
 *  `access.role` here is documentation, not enforcement: the production gate evaluator
 *  (`evaluateAccessGate` in the `access` layer) never reads `AccessSpec.role` — it authorizes purely by
 *  resource, against the hardcoded `POLICY` grant table. What actually keeps this admin-reachable is
 *  `admin`'s wildcard `{ action: 'read', resource: '*' }` grant matching `_outbox/dead`; `anonymous` has no
 *  grants at all, so it's refused (this is also exactly how the pre-existing `collections`/`brokenRefs`
 *  tooling reads are gated — nothing new here). One consequence worth being explicit about: `renderer`'s
 *  own grant is ALSO a resource wildcard (`{ action: 'read', resource: '*', scope: 'published' }`, for
 *  rendering any page-like collection at build time), so a renderer-principal request can read this
 *  resource too — there is no cheaper way to exclude just `renderer` from a wildcard grant through the
 *  declarative `AccessSpec` surface. Accepted as-is: `renderer` is never an external, untrusted caller (see
 *  `evaluateIpAllowlistGate`'s own renderer carve-out) — only the in-process build-time prerender and the
 * @public
 *  runtime publisher's render ever run as it. */
export function buildOutboxPipelines(): PipelineDef[] {
  return [
    definePipeline({
      name: 'outboxDead',
      read: true,
      access: { role: 'admin', resource: '_outbox/dead' },
      steps: [listDeadLetters],
    }),
  ]
}
