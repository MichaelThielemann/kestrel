import { Cause, Effect } from 'effect'
import { FiberFailureCauseId, isFiberFailure } from 'effect/Runtime'

// A test calling a step's `fn(ctx)` directly (below the pipeline runner) gets back a real Effect —
// running it still goes through Effect.runSync/runPromise's own FiberFailure wrapper, so a test asserting
// on the failure's shape (`_tag`, etc.) needs the same unwrap the runner itself does, or it sees the
// wrapper instead of the original KestrelError/defect.
function unwrap(error: unknown): unknown {
  return isFiberFailure(error) ? Cause.squash((error as { [FiberFailureCauseId]: Cause.Cause<unknown> })[FiberFailureCauseId]) : error
}

export function runStepSync<A>(effect: Effect.Effect<A, unknown>): A {
  try {
    return Effect.runSync(effect)
  } catch (error) {
    throw unwrap(error)
  }
}

export async function runStepAsync<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  try {
    return await Effect.runPromise(effect)
  } catch (error) {
    throw unwrap(error)
  }
}
