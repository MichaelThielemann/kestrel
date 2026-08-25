import { Effect } from 'effect'
import { definePipeline } from '../pipeline/define.js'
import { buildPipelineIndex } from '../pipeline/introspect.js'
import { syncStep, type PipelineDef, type StepDef } from '../pipeline/types.js'

const listPipelines: StepDef = syncStep('listPipelines', (ctx) => Effect.sync(() => {
  ctx.output = { pipelines: buildPipelineIndex() }
}))

/** `_pipelines` is itself a pipeline — a non-collection, admin-only read — so its own gates and steps show
 * @public
 *  up in its own output. */
export function buildIntrospectionPipelines(): PipelineDef[] {
  return [definePipeline({ name: '_pipelines', read: true, access: { role: 'admin' }, steps: [listPipelines] })]
}
