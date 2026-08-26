import type { FieldDef, SerializedField } from '@michaelthielemann/kestrel-core'
import { resolveFieldEmpty } from '../../../ui/app/utils/field-empty'

export interface ServerIssue {
  path: (string | number)[]
  message: string
  code?: string
}

export interface MappedErrors {
  fields: Record<string, string>
  form?: string
}

export interface FetchErrorInfo {
  statusCode?: number
  statusMessage?: string
  issues: ServerIssue[]
  /** The error body when it is NOT a Zod-issue array — e.g. `{ savedUpdatedAt }` from a failed write effect. */
  data?: Record<string, unknown>
}

// The wire `SerializedField` is structurally what every Field* widget and `validateField` read
// (flat type + options record + relation); only its discriminated-union typing differs. Narrow here.
export function asFieldDef(field: SerializedField): FieldDef {
  return field as unknown as FieldDef
}

// Read an ofetch/H3 error envelope: top-level statusCode/statusMessage, Zod issues nested at err.data.data.
// The BODY's statusMessage wins over the response's: ofetch maps `statusMessage` from `response.statusText`,
// and HTTP/2 has no reason phrase — behind any h2 proxy that arrives as '' and the real message is only in
// the JSON. Anything else under `data` (not an issue array) is handed back for the caller to act on.
export function readFetchError(e: unknown): FetchErrorInfo {
  const err = e as { statusCode?: number; statusMessage?: string; data?: { data?: ServerIssue[] } & Record<string, unknown> }
  const body = Array.isArray(err.data) ? undefined : err.data
  const raw = body?.data ?? err.data
  return {
    statusCode: err.statusCode,
    statusMessage: (body?.statusMessage as string | undefined) || err.statusMessage,
    issues: Array.isArray(raw) ? (raw as ServerIssue[]) : [],
    ...(body && !Array.isArray(body.data) ? { data: body } : {}),
  }
}

function cloneDefault(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value
}

function emptyForField(field: SerializedField): unknown {
  switch (field.type) {
    case 'text':
      return ''
    case 'boolean':
      return false
    case 'repeater':
      return []
    case 'choice':
      return field.options?.multiple ? [] : null
    case 'relation':
      return field.relation?.many ? [] : null
    case 'media':
      return field.options?.multiple ? [] : null
    default:
      // A consumer-defined type may register its blank shape (array/object-backed → [] / {}); else null.
      return resolveFieldEmpty(field.type)?.() ?? null
  }
}

/** Build a blank form state: a present (JSON-safe) default wins, else a type-appropriate empty. */
export function initialValues(fields: Record<string, SerializedField>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(fields)) {
    out[name] = 'default' in field ? cloneDefault(field.default) : emptyForField(field)
  }
  return out
}

/** Map a 400 body's Zod issues to per-field errors (by path[0]) and a single form-level error (empty path). */
export function mapServerErrors(issues: ServerIssue[] | null | undefined): MappedErrors {
  const fields: Record<string, string> = {}
  let form: string | undefined
  for (const issue of issues ?? []) {
    const head = issue.path?.[0]
    if (head === undefined || head === null || head === '') {
      if (form === undefined) form = issue.message
    } else {
      const name = String(head)
      if (!(name in fields)) fields[name] = issue.message
    }
  }
  return form === undefined ? { fields } : { fields, form }
}

/** Per-block (keyed by the stable `block.id`), per-field error map for inline block-content errors. */
export type BlockErrorMap = Record<string, Record<string, string>>

interface BlockLike {
  id?: unknown
  props?: Record<string, unknown>
  slots?: Record<string, unknown>
}

function blockId(block: unknown): string | null {
  const id = (block as BlockLike | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Parse nested block-content issues into a per-block, per-field error map keyed by the block's
 * stable `id`. The server reports a *position* path — `[key, i, 'props', field, …]` for a top-level
 * block, `[key, i, 'slots', name, j, 'props', field, …]` for one nested in a slot (any depth). We
 * walk that path through the submitted `content` to find the target block and pin the error to its
 * id, so it survives a later reorder at any level. First wins per field; an unresolvable path is
 * skipped.
 */
export function parseBlockErrors(
  issues: ServerIssue[] | null | undefined,
  content: readonly unknown[] | null | undefined,
  key = 'content',
): BlockErrorMap {
  const out: BlockErrorMap = {}
  for (const issue of issues ?? []) {
    const path = issue.path ?? []
    if (path[0] !== key) continue
    const hit = resolveBlockField(path.slice(1), content)
    if (!hit) continue
    out[hit.id] ??= {}
    if (!(hit.field in out[hit.id]!)) out[hit.id]![hit.field] = issue.message
  }
  return out
}

/**
 * Walk a position path (after the `content` head) through the block tree to the block whose
 * `props.<field>` the issue targets. Steps over `<index>, 'slots', <name>` segments into nested
 * slot arrays. Returns the target block's stable id + the field name, or null if the path is not a
 * `…props.<field>` leaf or any segment doesn't resolve to an identified block.
 */
function resolveBlockField(
  path: readonly (string | number)[],
  blocks: readonly unknown[] | null | undefined,
): { id: string; field: string } | null {
  let arr: readonly unknown[] | null | undefined = blocks
  for (let i = 0; i < path.length; ) {
    const index = path[i]
    if (typeof index !== 'number' || !Array.isArray(arr)) return null
    const block = arr[index] as BlockLike | undefined
    const next = path[i + 1]
    if (next === 'props') {
      const field = path[i + 2]
      const id = blockId(block)
      return typeof field === 'string' && id !== null ? { id, field } : null
    }
    if (next === 'slots') {
      const name = path[i + 2]
      if (typeof name !== 'string') return null
      const slot = block?.slots?.[name]
      arr = Array.isArray(slot) ? slot : null
      i += 3
      continue
    }
    return null
  }
  return null
}

/**
 * Carry block errors across a `content` change. A block (identified by its stable `id`, top-level or nested in
 * a slot at any depth) keeps its errors while it merely moves — a pure reorder, whether of its slot or of an
 * ancestor — and is dropped when removed; added blocks never gain an error. Reconciliation is PER-FIELD: an
 * edit clears only the edited field's stale message, so a still-invalid sibling field of the same block keeps
 * its error instead of all of them flickering away until the next save.
 */
export function reconcileBlockErrors(
  errors: BlockErrorMap,
  prev: readonly unknown[] | null | undefined,
  next: readonly unknown[] | null | undefined,
): BlockErrorMap {
  const prevById = new Map<string, BlockLike>()
  const nextById = new Map<string, BlockLike>()
  flattenBlocksById(prev, prevById)
  flattenBlocksById(next, nextById)
  const out: BlockErrorMap = {}
  for (const [id, errs] of Object.entries(errors)) {
    const before = prevById.get(id)
    const after = nextById.get(id)
    if (!before || !after) continue // removed → drop
    const beforeProps = (before.props ?? {}) as Record<string, unknown>
    const afterProps = (after.props ?? {}) as Record<string, unknown>
    const kept: Record<string, string> = {}
    for (const [field, message] of Object.entries(errs)) {
      // Keep a field's error only while THAT field's value is unchanged; editing it clears its own stale message.
      if (valuesEqual(beforeProps[field], afterProps[field])) kept[field] = message
    }
    if (Object.keys(kept).length) out[id] = kept
  }
  return out
}

/** Index every block in the tree (top-level and nested in slots) by its stable id. */
function flattenBlocksById(blocks: readonly unknown[] | null | undefined, into: Map<string, BlockLike>): void {
  for (const block of blocks ?? []) {
    const id = blockId(block)
    if (id !== null) into.set(id, block as BlockLike)
    const slots = (block as BlockLike | undefined)?.slots
    if (slots) for (const arr of Object.values(slots)) if (Array.isArray(arr)) flattenBlocksById(arr, into)
  }
}

/** One stale reference a record holds. Wire shape of `DeadRef` (kept structural here so this module stays
 *  Vue-free and doesn't import the admin-only `dead-refs.ts` type file). */
interface DeadRefLike {
  field: string
  blockId?: string
}

/**
 * Carry dead-reference warnings across a `content` change, mirroring `reconcileBlockErrors`: a warning at
 * a block (by stable id) is dropped once THAT field's value changes (the user swapped the broken
 * reference) or the block is removed; it survives a pure reorder. Root-level (non-block) dead refs are
 * untouched here — `setField` drops those directly when their own field is edited.
 */
export function reconcileDeadRefs<T extends DeadRefLike>(
  refs: readonly T[],
  prev: readonly unknown[] | null | undefined,
  next: readonly unknown[] | null | undefined,
): T[] {
  const prevById = new Map<string, BlockLike>()
  const nextById = new Map<string, BlockLike>()
  flattenBlocksById(prev, prevById)
  flattenBlocksById(next, nextById)
  return refs.filter((r) => {
    if (!r.blockId) return true
    const before = prevById.get(r.blockId)
    const after = nextById.get(r.blockId)
    if (!before || !after) return false
    const beforeVal = (before.props ?? {})[r.field]
    const afterVal = (after.props ?? {})[r.field]
    return valuesEqual(beforeVal, afterVal)
  })
}

/** Structural deep-equality for the value shapes the editor tracks (primitives, arrays, plain objects). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false

  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr !== bArr) return false
  if (aArr && bArr) {
    if (a.length !== b.length) return false
    return a.every((item, i) => valuesEqual(item, b[i]))
  }

  const aRec = a as Record<string, unknown>
  const bRec = b as Record<string, unknown>
  const aKeys = Object.keys(aRec)
  const bKeys = Object.keys(bRec)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bRec, k) && valuesEqual(aRec[k], bRec[k]))
}
