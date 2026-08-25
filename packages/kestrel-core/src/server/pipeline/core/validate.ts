import { Effect } from 'effect'
import { ValidationFailed } from '@kestrel/contracts'
import type { ZodType } from 'zod'
import { fieldIs, resolveColumnName } from '@kestrel/core'
import type { FieldDef } from '@kestrel/core'
/** @public */
export interface Issue { path: PropertyKey[], message: string, code?: string }

// Zod's path segments (string field names, numeric repeater/block indices) pass through as-is — the admin
// editor reads them positionally, so joining them into one string would destroy that structure.
function toValidationFailed(issues: Issue[]): ValidationFailed {
  return new ValidationFailed({
    issues: issues.map((i) => ({ path: i.path as (string | number)[], message: i.message, code: i.code })),
  })
}

/** Parse `body` against a collection schema — decision-only: fails as data, never throws. The shell
 * @public
 *  decides what to do with a `ValidationFailed`. */
export function decodeInput<T>(schema: ZodType<T>, body: unknown): Effect.Effect<T, ValidationFailed> {
  const parsed = schema.safeParse(body)
  return parsed.success ? Effect.succeed(parsed.data) : Effect.fail(toValidationFailed(parsed.error.issues))
}

/** @public */
export interface ConditionResult { issues: Issue[] }
/** @public */
export type ConditionChecker = (record: Record<string, unknown>) => ConditionResult | undefined

/** Re-enforce `required` for conditional fields whose condition is met, on the EFFECTIVE record (existing
 *  ⊕ patch for an update, the parsed record for a create) — `applyConditions` itself is the collection's
 * @public
 *  compiled per-field checker, already pure since a per-field schema can't see siblings. */
export function checkConditions(applyConditions: ConditionChecker | undefined, record: Record<string, unknown>): Effect.Effect<void, ValidationFailed> {
  const issues = applyConditions?.(record)?.issues
  return issues?.length ? Effect.fail(toValidationFailed(issues)) : Effect.succeed(undefined)
}

/** Fields a bulk PATCH must never rewrite in one statement: identity/timestamps/translation-group.
 * @public
 */
export function stripGuardedPatchKeys(patch: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, createdAt: _createdAt, translationGroup: _tg, singletonKey: _sk, ...rest } = patch
  return rest
}

// ---- transform ----
// Field-type `transform` is documented pure (no DB/Nitro) by its own descriptor contract
// (`registries/field-types.ts`'s `FieldTypeDescriptor`). The registry LOOKUPS themselves (`getFieldType`/
// `getBlock`) are module-level state, so the core takes them as injected capabilities-as-data
// (`TransformLookups`) instead of importing the registry — the shell (the step) is the only place that
// reaches into it.

type Row = Record<string, unknown>

/** @public */
export type FieldTransform = (value: unknown, record: Row, field: FieldDef) => unknown

/** @public */
export interface TransformLookups {
  getTransform(type: string): FieldTransform | undefined
  /** The field map of a registered block, or `undefined` for an unknown block type. */
  getBlockFields(blockType: string): Record<string, FieldDef> | undefined
}

/** Apply field-type write-transforms (e.g. slug auto-generation) before insert/update, returning the
 *  transformed values rather than mutating `values` — a core returns its decision, the shell applies
 *  it. `record` is the cross-field context a transform reads (`options.from`); when `record === values`
 *  (a create, where the caller has no separate merged snapshot) later fields see earlier fields' results,
 *  matching the original mutate-in-place ordering. `all` runs every transforming field (create, or a first
 *  singleton PUT); otherwise only fields present in `values` run (an unrelated edit must not silently
 *  rewrite a slug/URL). */
export function applyFieldTransforms(lookups: TransformLookups, fields: Record<string, FieldDef>, blocksEnabled: boolean | undefined, values: Row, record: Row, all: boolean): Row {
  const next: Row = { ...values }
  const effectiveRecord = record === values ? next : record
  for (const [key, fieldDef] of Object.entries(fields)) {
    const { jsKey: col } = resolveColumnName(key, fieldDef) // values are keyed by jsKey
    if (!all && !Object.hasOwn(next, col)) continue
    if (fieldIs(fieldDef, 'repeater')) {
      const arr = next[col]
      if (Array.isArray(arr)) next[col] = arr.map((entry) => (entry && typeof entry === 'object') ? transformNested(lookups, fieldDef.options.fields, entry as Row) : entry)
      continue
    }
    const transform = lookups.getTransform(fieldDef.type)
    if (transform) next[col] = transform(next[col], effectiveRecord, fieldDef)
  }
  // Block content is sent whole, so recurse transforms through each block's props + nested slots.
  if (blocksEnabled && (all || Object.hasOwn(next, 'content'))) next.content = transformBlocksValue(lookups, next.content)
  return next
}

/** Apply transforms inside a NESTED scope (a repeater entry or a block's props), returning a new object —
 *  the scope IS the full sibling context (the whole nested value is always sent), so a transform reads AND
 *  writes it; later fields in the SAME scope see earlier ones' results. Recurses into nested repeaters. */
function transformNested(lookups: TransformLookups, fields: Record<string, FieldDef>, scope: Row): Row {
  const next: Row = { ...scope }
  for (const [key, fieldDef] of Object.entries(fields)) {
    if (fieldIs(fieldDef, 'repeater')) {
      const arr = next[key]
      if (Array.isArray(arr)) next[key] = arr.map((entry) => (entry && typeof entry === 'object') ? transformNested(lookups, fieldDef.options.fields, entry as Row) : entry)
      continue
    }
    const transform = lookups.getTransform(fieldDef.type)
    if (transform) next[key] = transform(next[key], next, fieldDef)
  }
  return next
}

/** Recurse transforms through block content: each block's props (keyed by field name) + its slots' blocks,
 *  returning a new array rather than mutating `blocks`. */
function transformBlocksValue(lookups: TransformLookups, blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block
    const b = block as { type?: string, props?: unknown, slots?: unknown }
    const blockFields = typeof b.type === 'string' ? lookups.getBlockFields(b.type) : undefined
    const props = blockFields && b.props && typeof b.props === 'object' ? transformNested(lookups, blockFields, b.props as Row) : b.props
    const slots = b.slots && typeof b.slots === 'object'
      ? Object.fromEntries(Object.entries(b.slots as Record<string, unknown>).map(([slot, sub]) => [slot, transformBlocksValue(lookups, sub)]))
      : b.slots
    return { ...b, props, slots }
  })
}
