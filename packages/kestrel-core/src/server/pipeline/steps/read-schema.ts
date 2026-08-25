import { Effect } from 'effect'
import { buildCollectionActions } from '../../utils/collection-actions.js'
import { serializeCollection } from '../../utils/serialize-collection.js'
import { collectionOf } from './shared.js'
import { syncStep, type StepDef } from '../types.js'

/** The editor's own schema read — the unknown-collection 404 is already produced by the router's
 * @public
 *  `getCollectionOr404` before this step ever runs. */
export function schemaStep(): StepDef {
  return syncStep('schema', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    ctx.output = serializeCollection(c.def, buildCollectionActions(c.name))
  }))
}
