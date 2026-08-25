import { Effect } from 'effect'
import { definePipeline, eventOf, syncStep } from '@kestrel/core'
import type { PipelineDef, StepDef } from '@kestrel/core'
import { getAuthSession } from '../utils/session-cookie.js'
const readSession: StepDef = syncStep('readSession', (ctx) => Effect.sync(() => {
  ctx.output = getAuthSession(eventOf(ctx))
}))

/** `session` is publicly readable — the client needs it unauthenticated to know whether to redirect to
 *  login — but answers nothing scope-dependent, so `scope: 'published'` is a formality the access gate
 *  still requires of every public read.
 * @public
 */
export function buildSessionPipelines(): PipelineDef[] {
  return [definePipeline({ name: 'session', read: true, access: { public: true, scope: 'published' }, steps: [readSession] })]
}
