import { Effect } from 'effect'
import { Conflict } from '@kestrel/contracts'
import { unitsOf } from './shared.js'
import { syncStep, type StepDef } from '../types.js'

/**
 * Optimistic-concurrency precondition: `work.expectedUpdatedAt` is the `updatedAt` (epoch ms) the caller
 * last read. When it no longer matches the stored row the write is refused with 409, BEFORE any mutation —
 * so a stale editor tab can't silently revert a newer save (and propagate that revert into the static
 * output). A missing row still 404s later, not 409: the precondition only guards an existing row the
 * caller means to replace.
 * @public
 */
export function checkConcurrencyStep(): StepDef {
  return syncStep('checkConcurrency', (ctx) => {
    const before = unitsOf(ctx)[0]!.before!
    const current = before.updatedAt instanceof Date
      ? before.updatedAt.getTime()
      : new Date(before.updatedAt as string | number).getTime()
    if (current !== ctx.work.expectedUpdatedAt) {
      return Effect.fail(new Conflict({
        field: 'updatedAt',
        value: String(current),
        details: { kind: 'stale', expectedUpdatedAt: String(ctx.work.expectedUpdatedAt), actualUpdatedAt: String(current) },
      }))
    }
    return Effect.void
  }, {
    sealed: true,
    when: (ctx) => ctx.work.expectedUpdatedAt !== undefined && !!unitsOf(ctx)[0]?.before,
    whenLabel: 'the caller sent an `If-Unmodified-Since` baseline and the row exists',
  })
}
