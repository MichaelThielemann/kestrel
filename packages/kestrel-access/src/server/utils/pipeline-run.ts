import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { H3Event } from 'h3'
import { createPipelineContext, resolveDefaultPipeline, runPipeline, runPipelineSync } from '@kestrel/core'
import type { BuiltCollection, PipelineContext } from '@kestrel/core'
import { pipelineRequestFor, realGateEvaluators, resolveEventPrincipal } from './pipeline-gates.js'

/** What `runPipelineForEvent*` needs to run a pipeline against an incoming HTTP request.
 * @public
 */
export interface PipelineRunOptions {
  op: string
  collection?: BuiltCollection | null
  db?: BetterSQLite3Database | null
  input?: unknown
  id?: number
  locale?: string
  /** Step scratch a handler seeds (an `If-Unmodified-Since` precondition, say). The read-scope flags are
   *  stripped: for a request, those are the access gate's answer and nothing else's. */
  work?: Record<string, unknown>
  /** Called with the built context before the run starts — how a caller reaches the run's trace (dev
   *  logging, `?debug=pipeline`) without this module knowing about either. */
  onContext?: (ctx: PipelineContext) => void
}

const GATE_OWNED_WORK = ['publishedOnly', 'publicOnly'] as const

function workFor(options: PipelineRunOptions): Record<string, unknown> {
  const work = { ...options.work }
  for (const key of GATE_OWNED_WORK) Reflect.deleteProperty(work, key)
  return work
}

function contextFor<TOut>(event: H3Event, options: PipelineRunOptions, read: boolean) {
  const ctx = createPipelineContext<unknown, TOut>({
    op: options.op,
    collection: options.collection ?? null,
    db: options.db ?? null,
    input: options.input,
    id: options.id,
    locale: options.locale,
    work: workFor(options),
    principal: resolveEventPrincipal(event),
    request: pipelineRequestFor(event),
    read,
    event,
  })
  options.onContext?.(ctx)
  return ctx
}

/**
 * Run a pipeline for an incoming request: the principal, request plane and gate evaluators all come from
 * the event, so the pipeline's own `access`/`csrf`/`ipAllowlist` declarations decide the request. The read
 * scope the access gate resolves lands in `env` before the first step, which is where the read steps take
 * their published-only / public-only enforcement from.
 *
 * Synchronous like the CRUD facade it replaces: a write's `assertUnique → persist` window must not contain
 * an await. Use `runPipelineForEventAsync` for the one pipeline that reaches an async critical after-step.
 * @public
 */
export function runPipelineForEvent<TOut>(event: H3Event, options: PipelineRunOptions): TOut {
  const resolved = resolveDefaultPipeline(options.collection?.def.name ?? null, options.op)
  return runPipelineSync<TOut>(resolved, contextFor<TOut>(event, options, resolved.read), realGateEvaluators)
}

/** The async counterpart — for a pipeline whose steps or critical after-steps await (the singleton save's
 *  `writeRedirects`, `login`'s password hash).
 * @public
 */
export async function runPipelineForEventAsync<TOut>(event: H3Event, options: PipelineRunOptions): Promise<TOut> {
  const resolved = resolveDefaultPipeline(options.collection?.def.name ?? null, options.op)
  return runPipeline<TOut>(resolved, contextFor<TOut>(event, options, resolved.read), realGateEvaluators)
}

/**
 * Pick the driver from the pipeline itself — what a generic router needs, since it serves built-in and
 * consumer pipelines alike. The sync driver is what keeps a write's `assertUnique → persist` window free
 * of await points, so it is used whenever the composed pipeline can run without one.
 * @public
 */
export function runPipelineForEventAuto<TOut>(event: H3Event, options: PipelineRunOptions): TOut | Promise<TOut> {
  const resolved = resolveDefaultPipeline(options.collection?.def.name ?? null, options.op)
  const ctx = contextFor<TOut>(event, options, resolved.read)
  const needsAsync = resolved.steps.some((step) => !step.sync) || resolved.after.some((entry) => entry.critical)
  return needsAsync
    ? runPipeline<TOut>(resolved, ctx, realGateEvaluators)
    : runPipelineSync<TOut>(resolved, ctx, realGateEvaluators)
}
