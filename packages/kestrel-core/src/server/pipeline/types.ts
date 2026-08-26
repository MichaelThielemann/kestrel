import type { H3Event } from 'h3'
import type { Effect, Schema } from 'effect'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { KestrelError } from '@michaelthielemann/kestrel-contracts'
import type { BuiltCollection, Localized } from '@michaelthielemann/kestrel-core'
import type { TraceCollector } from './trace.js'

/** Loose on purpose: `core` documents a pipeline's wire shape for OpenAPI generation without depending on
 *  `@michaelthielemann/kestrel-contracts` or any concrete field-set type.
 * @public */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySchema = Schema.Schema<any, any, any>

/** `'published'` restricts a read to the published snapshot; `'all'` (admin-only) also sees drafts. Resolved
 * @public
 *  by the engine from the gate's `AccessSpec.scope` before the first step runs. */
export type ReadScope = 'published' | 'all'

/** Structurally identical to the access layer's `Principal`, restated so `core` keeps no dependency on
 * @public
 *  `access` (the engine only ever reads these two fields). */
export interface PipelinePrincipal {
  userId: string | null
  role: string
}

/** The transport-level facts of the triggering HTTP request. Not part of `RequestFacts` (facts stay
 * @public
 *  to what a step needs as a plain value) — engine-resolved into `ctx.exec.request`. */
export interface PipelineRequest {
  ip: string
  method: string
  headers: Record<string, string>
}

/** `ctx.exec`'s request field — same shape as `PipelineRequest`, named for the exec plane's own vocabulary.
 * @public
 */
export type RequestSnapshot = PipelineRequest

/** Plain-value facts about the run, resolved once by the engine before the first step and never mutated by
 *  a step (facts vs. ports). `principal` and `readScope` are resolved while evaluating the gates;
 *  `now`/`correlationId`/`causation` are resolved before gate 1, so every step and the outbox envelope share
 * @public
 *  one timestamp and one correlation id for the run. */
export interface RequestFacts {
  /** The collection name, or `''` for a collection-less pipeline (login, a consumer's own global pipeline).
   *  Steps needing the full `BuiltCollection` read `ctx.exec.collection` instead — this is the name alone. */
  collection: string
  op: string
  principal: PipelinePrincipal | null
  readScope: ReadScope
  locale: string
  /** ISO timestamp, resolved once per run. A step recording when the run happened (a row's `updatedAt`, a
   *  throttle window) reads this instead of calling `Date.now()`/`new Date()` itself. */
  now: string
  correlationId: string
  causation: Readonly<{ pipeline: string, op: string }>
}

/** `null` outside a run with a database attached (a gate-only unit test, say).
 * @public
 */
export type DbHandle = BetterSQLite3Database | null

/** Capabilities a step reaches through, never a plain value (shell only, not core-safe).
 * @public
 */
export interface PipelinePorts {
  readonly db: DbHandle
  /** Present only for a run driven by an HTTP request; `null` for a programmatic (trusted) run. Steps that
   *  own transport state — the session cookie, the login throttle — reach it through `eventOf`. */
  readonly event: H3Event | null
}

/** Engine-owned, read-only execution plane: resolved once before the first step (`collection`/`read` from
 *  route + pipeline resolution, `request` from the triggering event) and frozen at construction — gates and
 *  steps read it, nothing ever writes it after `createPipelineContext` builds it. Replaces the
 *  `ctx.work.collection`/`.read`/`.request` scratch a security-relevant gate used to read out of mutable
 * @public
 *  `work` (a review follow-up). */
export interface ExecPlane {
  collection: BuiltCollection | null
  read: boolean
  request: RequestSnapshot
}

/** The mutable run state threaded through every step of a pipeline: `input`/`output` carry the operation's
 *  payload, `facts`/`ports`/`exec` are read-only, and `work` is pure inter-step scratch — data one step
 * @public
 *  leaves for a later one, nothing the engine itself depends on. */
export interface PipelineContext<TIn = unknown, TOut = unknown> {
  input: TIn
  id?: number
  readonly facts: Readonly<RequestFacts>
  readonly ports: Readonly<PipelinePorts>
  readonly exec: Readonly<ExecPlane>
  output: TOut
  work: Record<string, unknown>
  trace: TraceCollector
}

/** A pipeline step body: mutates `ctx` in place (`input`/`output`/`work`) and returns an Effect whose
 *  error channel is a `KestrelError` — an expected failure is `Effect.fail(new SomeTaggedError(...))`,
 *  never a `throw`. A step may still `throw` a value that is NOT a `KestrelError` (a genuinely
 *  transport-level survivor, or a real bug) — the runner's `Cause.squash` at the outer `Effect.runSync`/
 *  `runPromise` boundary is the bug net for that, not a channel a step body writes to on purpose. The
 *  Effect itself may suspend (a real `await`), except inside the critical section — see `StepDef.sync`,
 * @public
 *  where `Effect.runSync` throws `AsyncFiberException` on a step that lied about being synchronous. */
export type StepFn = (ctx: PipelineContext) => Effect.Effect<void, KestrelError>

/** Not exported: nothing outside this module can write this key, so `sync: true` on a `StepDef` that
 *  lacks it is proof the step was built from a raw object literal rather than `syncStep` — see
 *  `stepBuiltBySyncStep` and `assertSyncBrand` in `registry.ts`. */
const SYNC_BRAND: unique symbol = Symbol('kestrel-step-sync-brand')

/** One step of a composed pipeline.
 * @public
 */
export interface StepDef {
  name: string
  fn: StepFn
  /** Part of the critical section: no step without this flag may sit between the first and the last
   *  `sync` step of a composed pipeline (see `assertCriticalSection`). Only `syncStep` may set this —
   *  `assertSyncBrand` rejects a raw literal that sets it directly, at compose time. */
  sync?: boolean
  /** @internal set only by `syncStep`, alongside `sync: true`. */
  [SYNC_BRAND]?: true
  /** Replaceable only through a patch entry carrying `unsafeReplace: true`. */
  sealed?: boolean
  when?: (ctx: PipelineContext) => boolean
  /** Human-readable form of `when`, shown in the trace when the step is skipped. */
  whenLabel?: string
}

/** Fields a step constructor may set besides `name`/`fn`/`sync`.
 * @public
 */
export interface StepOptions {
  sealed?: boolean
  when?: (ctx: PipelineContext) => boolean
  whenLabel?: string
}

/** The only way to produce a `StepDef` with `sync: true` — keeps the critical-section guarantee
 *  (`assertCriticalSection`) tied to one constructor instead of a flag scattered across step literals.
 * @public
 *  Stamps the unexported `SYNC_BRAND` so a raw `{ sync: true }` literal can be told apart at compose time. */
export function syncStep(name: string, fn: StepFn, options: StepOptions = {}): StepDef {
  return { name, fn, sync: true, [SYNC_BRAND]: true, ...options }
}

/** A step whose Effect may suspend. Never valid inside the critical section — `assertCriticalSection`
 * @public
 *  rejects an `asyncStep`-built step there at compose time, the same way it rejects any non-sync step. */
export function asyncStep(name: string, fn: StepFn, options: StepOptions = {}): StepDef {
  return { name, fn, ...options }
}

/** Whether `step.sync` was set by `syncStep` rather than a raw object literal — `registry.ts`'s
 * @public
 *  `assertSyncBrand` uses this to fail loud on the bypass instead of accepting a lookalike literal. */
export function stepBuiltBySyncStep(step: StepDef): boolean {
  return step[SYNC_BRAND] === true
}

/** A step registered to run after a pipeline's own steps (see `registerAfterStep`), outside the critical
 * @public
 *  section — the write is already committed by the time it runs. */
export interface AfterStepDef {
  step: StepDef
  /** `true` — a failure becomes the response (the row is already committed). `false` — logged into the
   *  trace, the run stays green. */
  critical: boolean
}

/** The access-gate half of a `GateSpec`: who may run the pipeline.
 * @public
 */
export interface AccessSpec {
  public?: boolean
  role?: string
  scope?: ReadScope
  /** Authorize against this resource instead of the collection's own name. The tooling reads enumerate
   *  draft ids, so they must not be covered by a grant on the bare collection. */
  resource?: string
}

/** The gates the engine evaluates before the first step runs. Every field is opt-in; an absent `access`
 * @public
 *  refuses the pipeline outright rather than defaulting to public. */
export interface GateSpec {
  /** Absent ⇒ the engine refuses to run the pipeline. */
  access?: AccessSpec
  csrf?: boolean
  ipAllowlist?: boolean
}

/** One edit against a standard pipeline's composed step list: insert `step` `before`/`after` a named step,
 *  or `replace` a named step outright. `replace` of a `sealed` step additionally needs `unsafeReplace: true`
 * @public
 *  — the sealed flag exists specifically to make that override visible at the call site. */
export type PatchOp =
  | { before: string, step: StepDef, unsafeReplace?: never }
  | { after: string, step: StepDef, unsafeReplace?: never }
  | { replace: string, step: StepDef, unsafeReplace?: boolean }

/** Admin-action presentation for a routable pipeline — how the admin UI renders it, not how the engine
 * @public
 *  runs it. Absent on the eight standard CRUD ops (they never surface as a generic action row). */
export interface PipelineActionUi {
  /** Which admin surface(s) may invoke this action. Unspecified defaults to `'bulk'` for a custom write
   *  pipeline (see `buildCollectionActions`) — the bulk bar is the common case; a row action needs `record`
   *  or `both` declared explicitly since the wire shape (`/<id>`, no body) differs from the bulk `{ids}` form. */
  kind?: 'bulk' | 'record' | 'both'
  label?: Localized
  icon?: string
  /** Show a confirm dialog before running (mirrors the built-in delete flow). */
  confirm?: boolean
}

/**
 * The author-facing shape of a custom pipeline, as passed to `definePipeline`. Extends `GateSpec` — a
 * pipeline that declares no gates is refused by the engine (see `GateSpec.access`).
 *
 * `steps` and `patch` are mutually exclusive: `steps` replaces a standard op's composed list wholesale,
 * `patch` edits it in place. Neither is required — a pipeline may patch nothing and only add `after` steps.
 *
 * @example
 * ```ts
 * definePipeline({
 *   name: 'publish',
 *   on: { collection: 'posts' },
 *   access: { role: 'editor' },
 *   patch: [{ after: 'assertUnique', step: markPublished }],
 * })
 * ```
 * @public
 */
export interface PipelineDef extends GateSpec {
  name: string
  on?: { collection?: string }
  /** Marks a custom pipeline as a read (GET-routed, no CSRF). Defaults to whether `name` is a standard
   *  read op. */
  read?: boolean
  /** The standard operation this def overrides. Defaults to `name` when `name` is a standard op. */
  op?: string
  /** Take the request body as a raw stream instead of a parsed JSON object: the router leaves `input`
   *  undefined and a step reads the event itself (multipart uploads, ciphertext bodies, capped reads). */
  rawBody?: boolean
  /** Replaces the composed step list wholesale. Mutually exclusive with `patch`. */
  steps?: StepDef[]
  patch?: PatchOp[]
  after?: AfterStepDef[]
  ui?: PipelineActionUi
  /** Request/response shape for OpenAPI generation only — the engine never validates against these.
   *  Absent ⇒ the generator documents the operation's schema as unknown. */
  input?: AnySchema
  output?: AnySchema
}

/** A `PipelineDef` after composition: `steps`/`patch` collapsed into one final `steps` list, gates merged
 * @public
 *  with the standard op's defaults. What the engine actually runs. */
export interface ResolvedPipeline {
  name: string
  collection: string | null
  read: boolean
  rawBody: boolean
  gates: GateSpec
  steps: StepDef[]
  after: AfterStepDef[]
  ui?: PipelineActionUi
  input?: AnySchema
  output?: AnySchema
}

/** The eight CRUD operations every collection gets by default, before any `PipelineDef` override.
 * @public
 */
export const STANDARD_OPS = [
  'createOne', 'createMany', 'readOne', 'readMany',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
] as const

/** One of the eight {@link STANDARD_OPS} names.
 * @public
 */
export type StandardOp = typeof STANDARD_OPS[number]

/** The editor's per-collection tooling-read op names (composed in `defaults.ts`), for anything that must
 *  treat "is this op a tooling read?" as one question — e.g. the action serializer, which suppresses them
 * @public
 *  all no matter how a consumer overrides one. */
export const TOOLING_READ_OPS = ['options', 'translations', 'deadRefs', 'schema', 'referrers'] as const

const STANDARD_OP_SET: ReadonlySet<string> = new Set<string>(STANDARD_OPS)

/** Type guard: whether `name` is one of the eight {@link STANDARD_OPS}, as opposed to a custom op name a
 * @public
 *  `PipelineDef` introduces. */
export function isStandardOp(name: string): name is StandardOp {
  return STANDARD_OP_SET.has(name)
}

/** The standard op names that are reads (`readOne`, `readMany`) — the set `ctx.exec.read` defaults from
 * @public
 *  when a custom `PipelineDef` omits its own `read` flag. */
export const READ_OPS: ReadonlySet<string> = new Set<string>(['readOne', 'readMany'])
