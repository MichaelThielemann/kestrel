import { createError } from 'h3'
import { Effect } from 'effect'
import { definePipeline } from '../pipeline/define.js'
import { buildCollectionActions } from '../utils/collection-actions.js'
import { allCollections } from '../utils/registry.js'
import { serializeCollection } from '../utils/serialize-collection.js'
import { findBrokenRefs } from '../utils/record-ref-index.js'
import { useContentDbFor } from '../db/content-db.js'
import { useDb } from '../utils/db.js'
import { syncStep, type PipelineDef, type StepDef } from '../pipeline/types.js'

const listCollections: StepDef = syncStep('listCollections', (ctx) => Effect.sync(() => {
  ctx.output = { data: allCollections().map((c) => serializeCollection(c.def, buildCollectionActions(c.name))) }
}))

const listBrokenRefs: StepDef = syncStep('listBrokenRefs', (ctx) => Effect.sync(() => {
  // Collection-less pipeline (`ctx.ports.db` is always null for these — see `api/[...path].ts`), so
  // there is no injected port to derive from.
  const rows = findBrokenRefs(useContentDbFor(useDb()).db)
  if (rows === null) throw createError({ statusCode: 503, statusMessage: 'Reference index unavailable' })
  ctx.output = rows
}))

/** Both admin-only, collection-less tooling reads: the editor's collection index and the global
 * @public
 *  broken-references report. */
export function buildToolingPipelines(): PipelineDef[] {
  return [
    definePipeline({ name: 'collections', read: true, access: { role: 'admin' }, steps: [listCollections] }),
    definePipeline({ name: 'brokenRefs', read: true, access: { role: 'admin' }, steps: [listBrokenRefs] }),
  ]
}
