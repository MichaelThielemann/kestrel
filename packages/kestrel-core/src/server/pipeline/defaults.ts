import { Effect } from 'effect'
import { ValidationFailed } from '@kestrel/contracts'
import type { KestrelError } from '@kestrel/contracts'
import { MAX_BULK_IDS } from '../../app/utils/list-limits.js'
import { buildDuplicateBody } from '../utils/duplicate.js'
import { parseIdList } from '../utils/http.js'
import { getCollection } from '../utils/registry.js'
import { createPipelineContext, type PipelineContextOptions } from './context.js'
import { definePipeline } from './define.js'
import { ensureDefaultPipelines, registerDefaultPipelines, resolvePipeline, setDefaultsInstaller } from './registry.js'
import { runAfterStepsSync, runPipeline, runPipelineSync, type GateEvaluators } from './runner.js'
import { assertUniqueStep } from './steps/assert-unique.js'
import { checkConcurrencyStep } from './steps/check-concurrency.js'
import { emitEventsStep } from './steps/emit-events.js'
import { assertAllExistStep, loadBeforeManyStep, loadBeforeStep } from './steps/load-before.js'
import { persistRollbackStep, persistStep } from './steps/persist.js'
import { attachMetaStep } from './steps/read-attach-meta.js'
import { fetchManyStep, fetchOneStep } from './steps/read-fetch.js'
import { parseQueryStep } from './steps/read-parse-query.js'
import { populateManyStep, populateOneStep } from './steps/read-populate.js'
import { referrersStep } from './steps/read-referrers.js'
import { schemaStep } from './steps/read-schema.js'
import { pickerOptionsStep, recordDeadRefsStep, resolveTranslationsStep } from './steps/read-tooling.js'
import { resolveLocaleStep } from './steps/resolve-locale.js'
import { resolveSlugStep } from './steps/resolve-slug.js'
import { loadRollbackTargetStep } from './steps/rollback.js'
import { assertNotSingleton, collectionOf, dbOf, fromThrowing, type Row, type WriteEvent } from './steps/shared.js'
import { transformStep } from './steps/transform.js'
import { patchOf, validateCreateStep, validatePatchStep, validateUpdateStep } from './steps/validate.js'
import { validateOutManyStep, validateOutOneStep } from './steps/validate-out.js'
import type { BuiltCollection } from '@kestrel/core'
import { syncStep, type AccessSpec, type PipelineContext, type PipelineDef, type ResolvedPipeline, type StepDef } from './types.js'

/** Every write is admin-only. The evaluators that turn a declaration into an answer are injected: an
 *  HTTP-driven run gets the real ones, a programmatic run the trusted ones below. */
const WRITE_ACCESS: AccessSpec = { role: 'admin' }

/** A pageLike collection is routable to a public URL, so its generic reads are the public content API —
 *  published rows only. Everything else is admin-only. This declaration IS the public set: nothing derives
 *  reachability from `pageLike` a second time (see `publicReadableResources`). */
function readAccessFor(collection: string | null): AccessSpec {
  const c = collection ? getCollection(collection) : undefined
  return c?.def.pageLike ? { public: true, scope: 'published' } : { role: 'admin', scope: 'all' }
}

/**
 * The id list a batch op operates on, in either of the two shapes it arrives in: a bare `number[]` from a
 * programmatic caller, or the `{ ids: [...] }` request envelope — which is validated here (positive
 * integers, deduped, capped) rather than at the route, so every entry point enforces one id contract.
 * `deleteOne` carries its single id in the URL instead, and has no body at all.
 */
function idsFromInput(ctx: PipelineContext): Effect.Effect<number[], ValidationFailed> {
  const input = ctx.input
  if (Array.isArray(input)) return Effect.succeed(input as number[])
  const ids = (input as { ids?: unknown } | null | undefined)?.ids
  if (ids !== undefined) return Effect.succeed(parseIdList(ids, MAX_BULK_IDS))
  if (ctx.id !== undefined) return Effect.succeed([ctx.id])
  return Effect.fail(new ValidationFailed({ issues: [{ path: ['ids'], message: 'ids must be a non-empty list' }] }))
}

/** `assertNotSingleton` still throws its own 405 survivor (a transport-level shape no tag fits) —
 *  `Effect.sync` keeps that a defect, unchanged, while giving the callback the `Effect<void, KestrelError>`
 *  shape `loadBeforeManyStep`'s `guard` parameter expects. */
function assertBatchWritable(ctx: PipelineContext): Effect.Effect<void, KestrelError> {
  return Effect.sync(() => assertNotSingleton(collectionOf(ctx)))
}

function assertPatchApplicable(ctx: PipelineContext): Effect.Effect<void, KestrelError> {
  return Effect.sync(() => assertNotSingleton(collectionOf(ctx))).pipe(
    Effect.flatMap(() => {
      const c = collectionOf(ctx)
      if ('status' in patchOf(ctx.input) && !c.def.status) {
        return Effect.fail(new ValidationFailed({ issues: [{ path: ['status'], message: `${c.name} has no status` }] }))
      }
      return Effect.void
    }),
  )
}

/** @public */
export function buildDefaultWritePipelines(): PipelineDef[] {
  // deleteOne runs deleteMany's list over `[id]` — one implementation, one flat trace, no nested run.
  const deleteSteps: StepDef[] = [
    loadBeforeManyStep(idsFromInput, assertBatchWritable),
    assertAllExistStep(),
    persistStep('deleteMany'),
    emitEventsStep(),
  ]

  return [
    definePipeline({
      name: 'createOne',
      access: WRITE_ACCESS,
      steps: [
        validateCreateStep(false),
        resolveLocaleStep('create'),
        resolveSlugStep('create'),
        transformStep('create'),
        assertUniqueStep(),
        persistStep('createOne'),
        emitEventsStep(),
      ],
    }),
    definePipeline({
      name: 'createMany',
      access: WRITE_ACCESS,
      steps: [
        validateCreateStep(true),
        resolveLocaleStep('create'),
        resolveSlugStep('create'),
        transformStep('create'),
        assertUniqueStep(),
        persistStep('createMany'),
        emitEventsStep(),
      ],
    }),
    definePipeline({
      name: 'updateOne',
      access: WRITE_ACCESS,
      steps: [
        loadBeforeStep(),
        checkConcurrencyStep(),
        validateUpdateStep(),
        resolveLocaleStep('update'),
        resolveSlugStep('update'),
        transformStep('update'),
        assertUniqueStep(),
        persistStep('updateOne'),
        emitEventsStep(),
      ],
    }),
    definePipeline({
      name: 'updateMany',
      access: WRITE_ACCESS,
      steps: [
        loadBeforeManyStep(idsFromInput, assertPatchApplicable),
        assertAllExistStep(),
        validatePatchStep(),
        persistStep('updateMany'),
        emitEventsStep(),
      ],
    }),
    definePipeline({ name: 'deleteOne', access: WRITE_ACCESS, steps: deleteSteps }),
    definePipeline({ name: 'deleteMany', access: WRITE_ACCESS, steps: deleteSteps }),
    definePipeline({
      name: 'rollback',
      access: WRITE_ACCESS,
      ui: { kind: 'record', confirm: true },
      steps: [
        loadRollbackTargetStep(),
        persistRollbackStep(),
        emitEventsStep(),
      ],
    }),
    definePipeline({
      name: 'duplicate',
      access: WRITE_ACCESS,
      // Strictly sequential: each copy is committed before the next body is derived, so a second copy of
      // the same source sees the first one when it de-dupes its slug.
      steps: [syncStep('duplicateRecords', (ctx) => Effect.gen(function* () {
        const c = collectionOf(ctx)
        const db = dbOf(ctx)
        const ids = yield* idsFromInput(ctx)
        // runWrite composes and runs the nested `createOne` pipeline synchronously to completion — its own
        // failure (a slug conflict, say) has already been reduced to throw-or-return at that boundary, so
        // fromThrowing is what reclassifies a KestrelError back into this step's own Fail channel instead
        // of letting it become a defect just because it crossed a plain function call.
        ctx.output = yield* fromThrowing(() => ids.map((id) => runWrite<Row>('createOne', {
          collection: c,
          db,
          input: buildDuplicateBody(db, c, id),
          principal: ctx.facts.principal,
          locale: ctx.facts.locale,
          trace: ctx.trace,
        })))
      }))],
    }),
  ]
}

/** `readMany` = parseQuery → fetch → attachMeta → populate → validateOut (attachMeta runs before populate:
 *  the two sidecars it attaches and the population pass touch disjoint fields, and the top-level row
 *  populator shallow-clones — `{ ...row }` — so attachMeta's `$hasDeadRefs`/`$translations` survive the
 *  clone). `validateOut` runs last so it sees every row exactly as the response will: populated sidecars
 *  included, but nested relation targets are already quarantined by their own recursive `readOne` before
 *  this step ever runs.
 *  `readOne` = fetch → populate → validateOut; unlike `readMany` it has no batch of sibling rows for
 *  `attachMeta` to attach a sidecar over, so that step is omitted (a deviation from the phase's step table).
 *  `readOne` absorbs the singleton lookup (`fetchOneStep`/`populateOneStep` branch on `ctx.id === undefined`) —
 * @public
 *  `getSingleton` runs `readOne` without an id, mirroring how `updateOne` absorbed `putSingleton`. */
export function buildDefaultReadPipelines(collection: string | null = null): PipelineDef[] {
  const access = readAccessFor(collection)
  return [
    definePipeline({
      name: 'readMany',
      access,
      steps: [parseQueryStep(), fetchManyStep(), attachMetaStep(), populateManyStep(), validateOutManyStep()],
    }),
    definePipeline({
      name: 'readOne',
      access,
      steps: [fetchOneStep(), populateOneStep(), validateOutOneStep()],
    }),
    ...buildToolingReadPipelines(collection),
  ]
}

/** The editor's per-collection tooling reads. They enumerate ids the generic read would hide (drafts,
 *  siblings in every locale, other records) or serve the schema itself, so each authorizes against its own
 *  `<collection>/<tool>` resource rather than the bare collection — a public read grant on the collection
 *  must never cover them. */
function buildToolingReadPipelines(collection: string | null): PipelineDef[] {
  const access = (tool: string): AccessSpec => ({ role: 'admin', scope: 'all', resource: collection ? `${collection}/${tool}` : tool })
  return [
    definePipeline({ name: 'options', read: true, access: access('options'), steps: [pickerOptionsStep()] }),
    definePipeline({ name: 'translations', read: true, access: access('translations'), steps: [resolveTranslationsStep()] }),
    definePipeline({ name: 'deadRefs', read: true, access: access('dead-refs'), steps: [recordDeadRefsStep()] }),
    definePipeline({ name: 'schema', read: true, access: access('schema'), steps: [schemaStep()] }),
    definePipeline({ name: 'referrers', read: true, access: access('referrers'), steps: [referrersStep()] }),
  ]
}

/** The built-in ops are all COLLECTION operations: a collection-less run (login, a consumer's own global
 *  pipeline) composes from the registry alone, so `/api/createOne` resolves to nothing routable. */
function buildAllDefaultPipelines(collection: string | null): PipelineDef[] {
  if (!collection) return []
  return [...buildDefaultWritePipelines(), ...buildDefaultReadPipelines(collection)]
}

/** The op names `buildAllDefaultPipelines` composes for a collection. Derived from the builders themselves
 *  rather than restated, because nothing resolves a default op until the first request — introspection has
 *  no registry entry to enumerate and would otherwise silently miss an op added to the builders. Which
 * @public
 *  collection is passed does not matter: only the access specs differ per collection, never the names. */
export function defaultCollectionOps(): string[] {
  return buildAllDefaultPipelines('*').map((def) => def.op ?? def.name)
}

/** A programmatic run is already inside the trust boundary: the caller is server code, not a request. It
 *  runs as the system principal at full scope, and the transport gates have nothing to check. */
const TRUSTED_GATES: Partial<GateEvaluators> = {
  access: () => ({ allowed: true, readScope: 'all' }),
  csrf: () => ({ allowed: true }),
  ipAllowlist: () => ({ allowed: true }),
}

const SYSTEM_PRINCIPAL = { userId: 'system', role: 'admin' }

function trusted(options: Omit<PipelineContextOptions, 'op'>, op: string, read: boolean): PipelineContextOptions {
  return { ...options, op, read, principal: options.principal ?? SYSTEM_PRINCIPAL }
}

/** The default defs are installed on first use, never at plugin-init time — nothing may read the registry
 *  while plugins are still registering. Writes and reads share one provider/registration so a consumer
 * @public
 *  patching either sees the other already resolved. */
export function resolveDefaultPipeline(collection: string | null, op: string): ResolvedPipeline {
  const resolved = tryResolveDefaultPipeline(collection, op)
  if (!resolved) throw new Error(`[kestrel] no pipeline registered for op "${op}"`)
  return resolved
}

/** The non-throwing form the router needs: an unknown name is a 404, not a crash.
 * @public
 */
export function tryResolveDefaultPipeline(collection: string | null, op: string): ResolvedPipeline | undefined {
  ensureDefaultPipelines()
  return resolvePipeline(collection, op)
}

setDefaultsInstaller(() => registerDefaultPipelines(buildAllDefaultPipelines))

export { isRoutablePipeline } from './registry.js'

/** The access declaration a collection's operation runs under — the single source every other consumer of
 *  "who may read this" reads from (`publicReadableResources`, and through it the sitemap and the populate
 * @public
 *  reachability predicate). */
export function pipelineAccess(collection: string | null, op: string): AccessSpec | undefined {
  return resolveDefaultPipeline(collection, op).gates.access
}

/** @public */
export function resolveWritePipeline(collection: string | null, op: string): ResolvedPipeline {
  return resolveDefaultPipeline(collection, op)
}

/** @public */
export function resolveReadPipeline(collection: string | null, op: string): ResolvedPipeline {
  return resolveDefaultPipeline(collection, op)
}

/** Run a write pipeline synchronously — the seam the CRUD facade delegates through.
 * @public
 */
export function runWrite<TOut>(op: string, options: Omit<PipelineContextOptions, 'op'>): TOut {
  const resolved = resolveWritePipeline(options.collection?.def.name ?? null, op)
  return runPipelineSync<TOut>(resolved, createPipelineContext<unknown, TOut>(trusted(options, op, resolved.read)), TRUSTED_GATES)
}

/** Run a read pipeline synchronously — the seam the CRUD facade's `list`/`getOne`/`getSingleton` delegate
 * @public
 *  through. Reads stay sync end to end (populate never returns a promise). */
export function runRead<TOut>(op: string, options: Omit<PipelineContextOptions, 'op'>): TOut {
  const resolved = resolveReadPipeline(options.collection?.def.name ?? null, op)
  return runPipelineSync<TOut>(resolved, createPipelineContext<unknown, TOut>(trusted(options, op, resolved.read)), TRUSTED_GATES)
}

/** The async counterpart — for the one write that can reach a critical async after-step (`writeRedirects`
 * @public
 *  on the singleton PUT). Every other write stays on the sync facade above. */
export async function runWriteAsync<TOut>(op: string, options: Omit<PipelineContextOptions, 'op'>): Promise<TOut> {
  const resolved = resolveWritePipeline(options.collection?.def.name ?? null, op)
  return runPipeline<TOut>(resolved, createPipelineContext<unknown, TOut>(trusted(options, op, resolved.read)), TRUSTED_GATES)
}

/** Run a write pipeline's after-steps against a synthetic event, outside of any main step run — for a
 *  write that bypasses core CRUD entirely (the media library's relocate/duplicate/delete/alt-edit paths)
 *  but must still reach the after-steps a CRUD write would. Composes with every registered after-step, but
 *  no IN-TREE one actually fires for `media` any more: `writeRedirects` registers with no `on.collection`
 *  restriction at all, yet is a no-op here because its OWN `when` guard only matches the redirects
 *  singleton; `reindexRefs`, `mediaCleanup`, and `planPublish` all moved to outbox handlers, driven instead
 *  by the real outbox row `media-write.ts`'s `emitMediaOutbox` writes atomically with the synthetic write's
 *  own row change (see its TSDoc) — not by this call. What this call still reaches is an EXTENSION's own
 *  after-step composed with no `on.collection` restriction (e.g. `galleries-secure`'s `galleryCleanup`,
 *  which scans every write's events for its own concerns and no-ops where none apply) — the seam stays for
 *  that, even with every in-tree consumer moved off it. Stays synchronous: nothing that can still fire here
 * @public
 *  is critical or returns a promise. */
export function runWriteAfterStepsSync(op: string, collection: BuiltCollection, event: WriteEvent): void {
  const resolved = resolveWritePipeline(collection.def.name, op)
  const ctx = createPipelineContext({ op, collection, work: { events: [event] } })
  runAfterStepsSync(resolved, ctx)
}
