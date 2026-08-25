import { isStandardOp, READ_OPS, stepBuiltBySyncStep, type AfterStepDef, type GateSpec, type PatchOp, type PipelineDef, type ResolvedPipeline, type StepDef } from './types.js'

const isReadOp = (name: string): boolean => READ_OPS.has(name)

/** The six write ops after-steps compose onto by default — read pipelines never run one (`work.events`
 * @public
 *  is a write-only concept). */
export const WRITE_OPS = ['createOne', 'createMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'] as const

/** Called per (collection, op) compose, not once: a built-in def's access declaration depends on the
 *  collection it runs for (a pageLike collection's reads are public, everything else is admin-only). */
type DefaultsProvider = (collection: string | null) => PipelineDef[]

const consumerDefs: PipelineDef[] = []
const cache = new Map<string, ResolvedPipeline | undefined>()
// One provider result per collection: the ops that deliberately share a step list (deleteOne/deleteMany)
// must compose from the same StepDef objects, not from two structurally equal copies.
const providerCache = new Map<string, PipelineDef[]>()

let provider: DefaultsProvider | null = null

/** The built-in pipelines, supplied as a provider so nothing is read at plugin-init time — the defs are
 * @public
 *  pulled on the first resolve. */
export function registerDefaultPipelines(defs: PipelineDef[] | DefaultsProvider): void {
  provider = typeof defs === 'function' ? defs : () => defs
  clearCaches()
}

/** Whether a defaults provider is installed — lets the built-in write facade install its own on first use
 * @public
 *  without reading the registry at plugin-init time. */
export function hasDefaultPipelines(): boolean {
  return provider !== null
}

let installDefaults: (() => void) | null = null

/** Lets the defaults module hand over its installer without anything here importing it — the registry must
 * @public
 *  stay below `defaults` in the module graph or the actions/schema steps close an import cycle. */
export function setDefaultsInstaller(fn: () => void): void {
  installDefaults = fn
}

/** Install the built-in default pipelines if none are registered yet (e.g. after `clearPipelines`). A
 * @public
 *  no-op until the defaults module has been imported somewhere in the process. */
export function ensureDefaultPipelines(): void {
  if (!hasDefaultPipelines()) installDefaults?.()
}

/** Whether a resolved pipeline can serve a request: it must do something, and it must say who may run it.
 * @public
 *  An after-only registration composes to neither, and must not become a reachable URL. */
export function isRoutablePipeline(resolved: ResolvedPipeline | undefined): resolved is ResolvedPipeline {
  return Boolean(resolved && resolved.steps.length > 0 && resolved.gates.access)
}

/**
 * A pipeline that lives at `/api/<name>` rather than under a collection: it brings its own full step list
 * for a name that is not a standard collection operation. Such a def is NOT an all-collections registration
 * — `/api/pages/login` must not resolve the login pipeline with `pages` as its collection. A def carrying
 * only `patch`/`after`, or overriding a standard op, keeps the collection-agnostic meaning.
 */
function isGlobalPipeline(def: PipelineDef): boolean {
  return !def.on?.collection && Boolean(def.steps) && !isStandardOp(targetOp(def))
}

/** @public */
export function globalPipelineNames(): string[] {
  return consumerDefs.filter(isGlobalPipeline).map(targetOp)
}

/** Installed by the collection registry so both registration orders fail loud on a name collision without
 *  `pipeline/` importing the collection registry (which imports this module). */
let collectionExists: ((name: string) => boolean) | null = null

/** @public */
export function setCollectionProbe(probe: (name: string) => boolean): void {
  collectionExists = probe
}

/** @public */
export function nameCollision(name: string, kind: 'collection' | 'pipeline'): Error {
  const other = kind === 'collection' ? 'pipeline' : 'collection'
  return new Error(`[kestrel] ${kind} "${name}" collides with a registered ${other} of the same name — /api/${name} would be ambiguous`)
}

/** @public */
export function registerPipeline(def: PipelineDef): void {
  const op = targetOp(def)
  if (isGlobalPipeline(def) && collectionExists?.(op)) throw nameCollision(op, 'pipeline')
  if (isStandardOp(def.name) && def.op !== undefined && def.op !== def.name) {
    throw new Error(`[kestrel] pipeline name "${def.name}" is a reserved standard operation — it may only be used to override that op, but this def targets "${def.op}"`)
  }
  if (!isStandardOp(def.name) && def.op !== undefined) {
    throw new Error(`[kestrel] pipeline "${def.name}" overrides the standard op "${def.op}" — an override must carry the op's own name`)
  }
  const scope = def.on?.collection ?? null
  // An after-only def (no `steps`/`patch`) has no anchor to collide over — its `after` entries simply
  // concatenate onto whatever else targets the same op, so many independent plugins can each register
  // their own named after-step for the same op/collection without racing for one registration slot.
  const isAfterOnly = !def.steps && !def.patch && Boolean(def.after)
  if (!isAfterOnly && consumerDefs.some((other) => targetOp(other) === op && (other.on?.collection ?? null) === scope)) {
    throw new Error(`[kestrel] pipeline "${op}" is already registered for ${scope ? `collection "${scope}"` : 'all collections'}`)
  }
  consumerDefs.push(def)
  clearCaches()
}

/** @public */
export interface RegisterAfterStepOptions {
  step: StepDef
  critical: boolean
  /** Defaults to every standard write op — an after-step is a write-only concept. */
  ops?: readonly string[]
  on?: { collection?: string }
}

/** Register one named after-step onto a set of write ops — the composable alternative to a bus listener.
 *  Each call is independent (see the after-only exemption above), so `writeRedirects` and any
 *  consumer/extension after-step can each be registered from their own plugin without racing each other.
 *  `reindexRefs`/`mediaCleanup`/`planPublish` are not registered through this mechanism — they are outbox
 *  handlers (`registerOutboxHandler`, `db/outbox-worker.ts`), dispatched by the poller after commit, not here.
 * @public */
export function registerAfterStep(options: RegisterAfterStepOptions): void {
  for (const op of options.ops ?? WRITE_OPS) {
    registerPipeline({ name: op, on: options.on, after: [{ step: options.step, critical: options.critical }] })
  }
}

/** @public */
export interface PipelineTarget {
  collection: string | null
  op: string
}

/** Every (collection, op) a consumer def anchors — introspection's other half of "what exists" (the
 *  built-in per-collection ops are enumerated by the caller, since only the collection registry knows
 * @public
 *  their names). Excludes after-only defs: they enrich an existing op's `after` list, not a new target. */
export function consumerPipelineTargets(): PipelineTarget[] {
  const seen = new Set<string>()
  const out: PipelineTarget[] = []
  for (const def of consumerDefs) {
    if (!def.steps && !def.patch && Boolean(def.after)) continue
    const collection = def.on?.collection ?? null
    const op = targetOp(def)
    const key = `${collection ?? '*'}::${op}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ collection, op })
  }
  return out
}

/** @public */
export function clearPipelines(): void {
  consumerDefs.length = 0
  provider = null
  clearCaches()
}

function clearCaches(): void {
  cache.clear()
  providerCache.clear()
}

/** Drop the composed-pipeline cache without touching what is registered — the collection registry calls
 *  this when its contents change, since a built-in read pipeline's access declaration is derived from the
 * @public
 *  collection it was composed for. */
export function invalidatePipelineCache(): void {
  clearCaches()
}

/** @public */
export function resolvePipeline(collection: string | null, opName: string): ResolvedPipeline | undefined {
  const key = `${collection ?? '*'}::${opName}`
  if (cache.has(key)) return cache.get(key)
  const resolved = compose(collection, opName)
  cache.set(key, resolved)
  return resolved
}

function defaultDefs(collection: string | null): PipelineDef[] {
  if (!provider) return []
  const key = collection ?? '*'
  let defs = providerCache.get(key)
  if (!defs) providerCache.set(key, defs = provider(collection))
  return defs
}

function targetOp(def: PipelineDef): string {
  return def.op ?? def.name
}

function compose(collection: string | null, opName: string): ResolvedPipeline | undefined {
  const base = defaultDefs(collection).find((def) => targetOp(def) === opName)
  const applicable = consumerDefs
    .filter((def) => targetOp(def) === opName
      && (!def.on?.collection || def.on.collection === collection)
      && (collection === null || !isGlobalPipeline(def)))
    // Collection-agnostic defs compose first so a collection-specific one patches on top of them.
    .sort((a, b) => Number(Boolean(a.on?.collection)) - Number(Boolean(b.on?.collection)))
  if (!base && applicable.length === 0) return undefined

  const label = `pipeline "${opName}"${collection ? ` (collection "${collection}")` : ''}`
  let steps: StepDef[] = [...(base?.steps ?? [])]
  let after: AfterStepDef[] = [...(base?.after ?? [])]
  let read = base?.read ?? isReadOp(opName)
  let rawBody = base?.rawBody ?? false
  let ui = base?.ui
  let input = base?.input
  let output = base?.output
  const gates: GateSpec = { access: base?.access, csrf: base?.csrf, ipAllowlist: base?.ipAllowlist }

  for (const def of applicable) {
    if (def.read !== undefined) read = def.read
    if (def.rawBody !== undefined) rawBody = def.rawBody
    if (def.steps) steps = [...def.steps]
    for (const patch of def.patch ?? []) applyPatch(steps, patch, label)
    if (def.after) after = [...after, ...def.after]
    if (def.access !== undefined) gates.access = def.access
    if (def.csrf !== undefined) gates.csrf = def.csrf
    if (def.ipAllowlist !== undefined) gates.ipAllowlist = def.ipAllowlist
    if (def.ui !== undefined) ui = def.ui
    if (def.input !== undefined) input = def.input
    if (def.output !== undefined) output = def.output
  }

  assertUniqueNames(steps, label)
  assertSyncBrand(steps, label)
  assertCriticalSection(steps, label)

  return { name: opName, collection: collection ?? null, read, rawBody, gates, steps, after, ui, input, output }
}

function applyPatch(steps: StepDef[], patch: PatchOp, label: string): void {
  const anchor = 'before' in patch ? patch.before : 'after' in patch ? patch.after : patch.replace
  const index = steps.findIndex((step) => step.name === anchor)
  if (index === -1) {
    throw new Error(`[kestrel] ${label}: patch anchor "${anchor}" matches no step — known steps: ${steps.map((s) => s.name).join(', ') || '(none)'}`)
  }
  if ('replace' in patch) {
    if (steps[index]!.sealed && !patch.unsafeReplace) {
      throw new Error(`[kestrel] ${label}: step "${anchor}" is sealed — replacing it drops a guarantee the engine relies on; pass \`unsafeReplace: true\` if that is intended`)
    }
    steps[index] = patch.step
    return
  }
  steps.splice('before' in patch ? index : index + 1, 0, patch.step)
}

function assertUniqueNames(steps: StepDef[], label: string): void {
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.name)) {
      throw new Error(`[kestrel] ${label}: step name "${step.name}" appears twice — patch anchors would be ambiguous`)
    }
    seen.add(step.name)
  }
}

/** `sync: true` proves nothing on its own — a raw object literal can set it without the guarantee
 *  `syncStep` actually provides (no await inside `fn`). Reject any step that carries the flag without
 *  the brand only `syncStep` can stamp, so the critical-section check below can trust it. */
function assertSyncBrand(steps: StepDef[], label: string): void {
  for (const step of steps) {
    if (step.sync && !stepBuiltBySyncStep(step)) {
      throw new Error(`[kestrel] ${label}: step "${step.name}" sets \`sync: true\` without going through \`syncStep\` — construct it via \`syncStep(name, fn)\` instead of a raw object literal`)
    }
  }
}

/** The composed list must keep its `sync` steps contiguous: an async step between the first and the last
 *  of them would open the very TOCTOU window (unique slugs, optimistic concurrency) the flag exists to
 *  close. Checked here so a bad patch fails at compose time, never mid-request. */
function assertCriticalSection(steps: StepDef[], label: string): void {
  const first = steps.findIndex((step) => step.sync)
  if (first === -1) return
  let last = first
  for (let i = steps.length - 1; i > first; i--) {
    if (steps[i]!.sync) { last = i; break }
  }
  for (let i = first + 1; i < last; i++) {
    const step = steps[i]!
    if (step.sync) continue
    const previous = steps.slice(0, i).reverse().find((s) => s.sync)!
    const next = steps.slice(i + 1).find((s) => s.sync)!
    throw new Error(`[kestrel] ${label}: step "${step.name}" is not \`sync: true\` but sits inside the critical section, between "${previous.name}" and "${next.name}"`)
  }
}
