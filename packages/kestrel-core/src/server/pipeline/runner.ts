import { Cause, Effect, Layer, ManagedRuntime } from 'effect'
import { FiberFailureCauseId, isAsyncFiberException, isFiberFailure } from 'effect/Runtime'
import { Forbidden, Unauthorized } from '@michaelthielemann/kestrel-contracts'
import type { AccessSpec, PipelineContext, RequestFacts, ResolvedPipeline, StepDef } from './types.js'

/** @public */
export interface GateOutcome {
  allowed: boolean
  detail?: string
  /** Read scope the access gate resolved; written into `facts` before the first step runs. */
  readScope?: RequestFacts['readScope']
  /** Response status/message of a denial. Missing authentication is 401, a refused request 403 — the
   *  distinction is part of the contract, not cosmetic. Constrained to the two tags the edge map can
   *  express (`Unauthorized`/`Forbidden`): a gate wanting a genuinely transport-level status (429, 503,
   *  …) must throw its own error rather than return an outcome — `GateOutcome` denials are not a general
   *  arbitrary-status channel. */
  status?: 401 | 403
  message?: string
}

/** @public */
export interface GateEvaluators {
  access: (spec: AccessSpec, ctx: PipelineContext) => GateOutcome | Promise<GateOutcome>
  csrf: (ctx: PipelineContext) => GateOutcome | Promise<GateOutcome>
  ipAllowlist: (ctx: PipelineContext) => GateOutcome | Promise<GateOutcome>
}

/** @public */
export const defaultGateEvaluators: GateEvaluators = {
  access(spec, ctx) {
    if (spec.public) return { allowed: true, readScope: spec.scope ?? 'published' }
    const principal = ctx.facts.principal
    if (!principal) return { allowed: false, detail: 'authentication required' }
    if (spec.role && principal.role !== spec.role && principal.role !== 'admin') {
      return { allowed: false, detail: `role "${spec.role}" required` }
    }
    return { allowed: true, readScope: spec.scope ?? 'all' }
  },
  csrf: () => ({ allowed: true }),
  ipAllowlist: () => ({ allowed: true }),
}

/** Shared handle the async driver runs every effect through — empty today; a later item hangs real service
 *  layers (DB, event bus) off this same handle instead of each call site building its own runtime.
 *  Long-lived for the process; not tied to a single request. */
const runtime = ManagedRuntime.make(Layer.empty)

function isThenable(value: unknown): boolean {
  return typeof (value as Promise<unknown> | undefined)?.then === 'function'
}

function message(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

function denied(detail: string): Forbidden {
  return new Forbidden({ reason: detail })
}

/** A gate outcome's `status`/`message` (see `GateOutcome`'s doc: missing auth is 401, a refused request
 *  403) picks the tag — everything else about the denial is the same `reason` text either way, so the
 *  edge map (`kestrel-error-map.ts`) is the only place that turns this into an HTTP status. */
function refused(outcome: GateOutcome, fallback: string): Forbidden | Unauthorized {
  const reason = outcome.message ?? outcome.detail ?? fallback
  return outcome.status === 401 ? new Unauthorized({ reason }) : new Forbidden({ reason })
}

/** `Effect.runSync`/`ManagedRuntime.runPromise` both throw/reject with a `FiberFailure` wrapping the real
 *  cause, never the original error object — squashing it back out is what keeps a step's or gate's thrown
 *  value (a `KestrelError`, or a genuine defect) reaching the HTTP edge byte-identical to before this
 *  module used Effect at all. */
function unwrapFiberFailure(error: unknown): unknown {
  if (isFiberFailure(error)) {
    return Cause.squash((error as { [FiberFailureCauseId]: Cause.Cause<unknown> })[FiberFailureCauseId])
  }
  return error
}

const SYNC_GUARD = (name: string): string => `[kestrel] pipeline "${name}" was run synchronously but a step or gate returned a promise`

/** Every step's Effect is real — a genuinely async one suspends `Effect.runSync` itself, which throws
 *  `AsyncFiberException` natively. That IS the guard a step lying about `sync: true` trips; this turns it
 *  into the same message an `isThenable` check would produce, so the guard's wording stays consistent. */
function runSyncEffect<TOut>(effect: Effect.Effect<TOut, unknown>, guardMessage: string): TOut {
  try {
    return Effect.runSync(effect)
  } catch (error) {
    const unwrapped = unwrapFiberFailure(error)
    if (isAsyncFiberException(unwrapped)) throw new Error(guardMessage, { cause: error })
    throw unwrapped
  }
}

async function runPromiseEffect<TOut>(effect: Effect.Effect<TOut, unknown>): Promise<TOut> {
  try {
    return await runtime.runPromise(effect)
  } catch (error) {
    throw unwrapFiberFailure(error)
  }
}

/**
 * One gate-evaluator call as an Effect — gates are still plain functions returning
 * `GateOutcome | Promise<GateOutcome>`, so they still need this
 * throw/thenable bridge. `sync` selects the wrapper: `Effect.sync` for the runSync driver — a value that
 * turns out to be a promise anyway (a custom gate evaluator) throws the same guard error a lying step
 * trips via `AsyncFiberException`, rather than silently returning an unawaited promise as the gate's
 * "result". `Effect.tryPromise` for the async driver tolerates either a plain return or a promise, and
 * turns a synchronous throw inside `fn` into the effect's failure exactly like a rejected promise would.
 */
function effectOf<T>(sync: boolean, guardMessage: string, fn: () => T | Promise<T>): Effect.Effect<T, unknown> {
  return sync
    ? Effect.sync(() => {
        const result = fn()
        if (isThenable(result)) throw new Error(guardMessage)
        return result as T
      })
    : Effect.tryPromise({ try: () => Promise.resolve(fn()), catch: (error) => error })
}

/** One step's effect, wrapped with the same before/after trace calls `beginStep`'s closure always made —
 *  `Effect.tap`/`Effect.tapErrorCause` run those side effects without needing a JS try/catch around the
 *  `yield*` (which does not observe an Effect failure — only its own combinators do). A step's `fn` already
 *  returns its own Effect — nothing here wraps or adapts it; the driver-level `runSyncEffect`/
 *  `runPromiseEffect` is where a lying-sync step's suspension surfaces. */
function stepEffect(ctx: PipelineContext, step: StepDef, phase: 'main' | 'after', critical: boolean | undefined): Effect.Effect<void, unknown> {
  const end = ctx.trace.beginStep(step.name, phase, critical)
  return step.fn(ctx).pipe(
    Effect.tap(() => Effect.sync(() => end('ok'))),
    Effect.tapErrorCause((cause) => Effect.sync(() => end('error', message(Cause.squash(cause))))),
  )
}

function mainStepsEffect(resolved: ResolvedPipeline, ctx: PipelineContext): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const step of resolved.steps) {
      if (step.when && !step.when(ctx)) {
        ctx.trace.beginStep(step.name, 'main')('skipped-condition', step.whenLabel ?? 'when() returned false')
        continue
      }
      yield* stepEffect(ctx, step, 'main', undefined)
    }
  })
}

/** The after-step loop, factored out so it can also be driven on its own (e.g. a synthetic write outside
 *  the main pipeline, like the media library's bypass-CRUD writes) rather than only as the plan's tail. */
function afterStepsEffect(resolved: ResolvedPipeline, ctx: PipelineContext): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const { step, critical } of resolved.after) {
      if (step.when && !step.when(ctx)) {
        ctx.trace.beginStep(step.name, 'after', critical)('skipped-condition', step.whenLabel ?? 'when() returned false')
        continue
      }
      const effect = stepEffect(ctx, step, 'after', critical)
      if (critical) {
        yield* effect
        continue
      }
      // Non-critical: the trace already recorded the error (stepEffect's tapErrorCause ran first); log and
      // keep going instead of failing the whole run.
      yield* effect.pipe(Effect.catchAllCause((cause) => Effect.sync(() => {
        console.error(`[kestrel] after-step "${step.name}" of pipeline "${resolved.name}" failed:`, Cause.squash(cause))
      })))
    }
  })
}

/** Run just a pipeline's after-steps against an already-populated ctx (`ctx.work.events` set by the
 * @public
 *  caller) — the async driver, for a critical after-step that must be awaited (e.g. `writeRedirects`). */
export function runAfterSteps(resolved: ResolvedPipeline, ctx: PipelineContext): Promise<void> {
  return runPromiseEffect(afterStepsEffect(resolved, ctx))
}

/** The sync counterpart — for a caller (like the media library's bypass-CRUD write path) that never
 * @public
 *  reaches a critical async after-step, so it can stay synchronous like the rest of that call chain. */
export function runAfterStepsSync(resolved: ResolvedPipeline, ctx: PipelineContext): void {
  runSyncEffect(afterStepsEffect(resolved, ctx), SYNC_GUARD(resolved.name))
}

/** Gate order — ipAllowlist, csrf, access — mirrors the network-to-identity order the route middleware
 *  enforced: an unlisted IP and a cross-origin write are both refused before the request's identity is
 *  ever considered, so a 403 never turns into a 401 for the same request. */
function gatePlanEffect(resolved: ResolvedPipeline, ctx: PipelineContext, gates: GateEvaluators, sync: boolean): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const access = resolved.gates.access
    if (!access) {
      ctx.trace.gate('access', false, 'no access declaration — default deny')
      throw denied(`pipeline "${resolved.name}" declares no access`)
    }
    const guardMessage = SYNC_GUARD(resolved.name)

    if (resolved.gates.ipAllowlist === false) {
      ctx.trace.gate('ipAllowlist', true, 'not required')
    } else {
      const ip = yield* effectOf(sync, guardMessage, () => gates.ipAllowlist(ctx))
      ctx.trace.gate('ipAllowlist', ip.allowed, ip.detail)
      if (!ip.allowed) throw refused(ip, 'IP not allowed')
    }

    const csrfRequired = resolved.gates.csrf ?? !resolved.read
    if (!csrfRequired) {
      ctx.trace.gate('csrf', true, 'not required')
    } else {
      const csrf = yield* effectOf(sync, guardMessage, () => gates.csrf(ctx))
      ctx.trace.gate('csrf', csrf.allowed, csrf.detail)
      if (!csrf.allowed) throw refused(csrf, 'CSRF check failed')
    }

    const outcome = yield* effectOf(sync, guardMessage, () => gates.access(access, ctx))
    ctx.trace.gate('access', outcome.allowed, outcome.detail)
    if (!outcome.allowed) throw refused(outcome, `pipeline "${resolved.name}" denied`)
    if (outcome.readScope) (ctx.facts as RequestFacts).readScope = outcome.readScope
  })
}

function planEffect<TOut>(resolved: ResolvedPipeline, ctx: PipelineContext<unknown, TOut>, gates: GateEvaluators, sync: boolean): Effect.Effect<TOut, unknown> {
  return Effect.gen(function* () {
    yield* gatePlanEffect(resolved, ctx as PipelineContext, gates, sync)
    yield* mainStepsEffect(resolved, ctx as PipelineContext)
    yield* afterStepsEffect(resolved, ctx as PipelineContext)
    return ctx.output
  })
}

/** @public */
export function runPipeline<TOut>(
  resolved: ResolvedPipeline,
  ctx: PipelineContext<unknown, TOut>,
  evaluators: Partial<GateEvaluators> = {},
): Promise<TOut> {
  return runPromiseEffect(planEffect(resolved, ctx, { ...defaultGateEvaluators, ...evaluators }, false))
}

/** The synchronous driver over the same plan — for callers that must stay sync (today's CRUD facade) and
 *  therefore compose only sync steps and sync gate evaluators. A step that returns a promise is a hard
 * @public
 *  error rather than a silently unawaited write. */
export function runPipelineSync<TOut>(
  resolved: ResolvedPipeline,
  ctx: PipelineContext<unknown, TOut>,
  evaluators: Partial<GateEvaluators> = {},
): TOut {
  return runSyncEffect(planEffect(resolved, ctx, { ...defaultGateEvaluators, ...evaluators }, true), SYNC_GUARD(resolved.name))
}
