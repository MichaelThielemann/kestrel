import { Effect } from 'effect'
import { definePipeline, syncStep, useDb } from '@michaelthielemann/kestrel-core'
import type { PipelineDef, StepDef } from '@michaelthielemann/kestrel-core'
import { resolveInternalHref } from '../utils/content/link-resolve.js'

// Batch-resolve internal link refs (`?refs=collection:id,collection:id`) to public hrefs for the admin
// block preview. Mirrors the read-path populator, status gate included; only resolved refs are returned,
// so the client renders '#' for a target that is missing or still a draft — same as the generated site.
const resolveRefs: StepDef = syncStep('resolveRefs', (ctx) => Effect.sync(() => {
  const refs = String((ctx.input as { refs?: unknown } | undefined)?.refs ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const db = useDb()
  const data: { collection: string; id: number; href: string }[] = []
  for (const ref of refs) {
    const sep = ref.lastIndexOf(':')
    if (sep <= 0) continue
    const collection = ref.slice(0, sep)
    const id = Number(ref.slice(sep + 1))
    if (!Number.isInteger(id) || id <= 0) continue
    const href = resolveInternalHref(collection, id, db)
    if (href != null) data.push({ collection, id, href })
  }
  ctx.output = { data }
}))

/** @public */
export function buildLinkPipelines(): PipelineDef[] {
  return [definePipeline({ name: 'resolveLinks', read: true, access: { role: 'admin' }, steps: [resolveRefs] })]
}
