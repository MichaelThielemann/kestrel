import { Effect } from 'effect'
import { definePipeline, serializeBlock, syncStep } from '@michaelthielemann/kestrel-core'
import type { PipelineDef, StepDef } from '@michaelthielemann/kestrel-core'
import { allBlocks } from '../utils/defineBlock.js'
type Query = Record<string, unknown>

const listBlocks: StepDef = syncStep('listBlocks', (ctx) => Effect.sync(() => {
  const query = (ctx.input ?? {}) as Query
  const allowed = typeof query.allowed === 'string' && query.allowed.length
    ? query.allowed.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined
  ctx.output = { data: allBlocks(allowed).map(serializeBlock) }
}))

/** Admin-only (default-deny applies to /api/**): the per-block field schemas the editor needs to render
 *  block inputs. `?allowed=a,b` restricts to a collection's allowed block types.
 * @public
 */
export function buildBlocksPipelines(): PipelineDef[] {
  return [definePipeline({ name: 'blocks', read: true, access: { role: 'admin' }, steps: [listBlocks] })]
}
