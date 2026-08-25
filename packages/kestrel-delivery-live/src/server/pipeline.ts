import { createError } from 'h3'
import { Effect } from 'effect'
import { definePipeline, syncStep, isDeliveryLive } from '@kestrel/core'
import type { PipelineDef, StepDef } from '@kestrel/core'
import { usePublishingDb, currentSnapshot } from '@kestrel/publishing'

/** Intentionally does not set an ETag/304 response header: the snapshot's `fingerprint` travels in the
 *  JSON payload itself for this read pipeline, so callers compare it there rather than via HTTP caching. */
const readSnapshot: StepDef = syncStep('readSnapshot', (ctx) => Effect.sync(() => {
  // Inert under 'static' (the default): the same 404 an unknown pipeline gets, so switching delivery
  // modes never widens what an anonymous caller can read.
  if (!isDeliveryLive()) throw createError({ statusCode: 404, statusMessage: 'delivery-live is not enabled' })
  const input = (ctx.input ?? {}) as Record<string, unknown>
  const route = typeof input.route === 'string' ? input.route : ''
  const snapshot = currentSnapshot(usePublishingDb().db, route)
  if (!snapshot) throw createError({ statusCode: 404, statusMessage: `No published snapshot for route "${route}"` })
  ctx.output = snapshot
}))

/** The delivery-live read API: the current published snapshot for a route, publicly — published
 *  content is public by definition, the same rule `route` (the pageLike render entry, in
 *  `pipelines/route.ts`) already applies. Reads ONLY through `currentSnapshot` (the store's own read
 *  surface, ADR-0013 §3.3): never a draft, never a live-rendered populate. Routed at `/api/deliverySnapshot`
 *  (collection-less pipelines live at `/api/<name>` — see `api/[...path].ts`'s URL grammar).
 *  @public */
export function buildDeliveryLivePipelines(): PipelineDef[] {
  return [
    definePipeline({
      name: 'deliverySnapshot',
      read: true,
      access: { public: true, scope: 'published', resource: '_delivery/snapshot' },
      steps: [readSnapshot],
    }),
  ]
}
