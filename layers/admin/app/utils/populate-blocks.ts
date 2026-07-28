import type { SerializedBlock, SerializedField } from '../../../core/server/utils/serialize-collection'
import type { ResolvedMedia } from '../../../media/app/composables/useMediaResolver'
import { collectRichtextRefs, resolveRichtextLinks } from '../../../fields/app/utils/richtext-links'

// Single source of truth for the resolved-media shape lives in the media layer (admin → media).
export type { ResolvedMedia }

interface BlockNode {
  id?: string
  type: string
  props?: Record<string, unknown>
  [k: string]: unknown
}

/** The sub-field schema of a `repeater` SerializedField, or null. Serialized as `options.fields` (a
 *  name→SerializedField map, recursively) by `serializeField`. */
function repeaterFields(field: SerializedField): Record<string, SerializedField> | null {
  if (field.type !== 'repeater') return null
  const sub = (field.options as { fields?: Record<string, SerializedField> } | undefined)?.fields
  return sub && typeof sub === 'object' ? sub : null
}

/** A block's `slots` bag from the data (a name→child-array map), or null if it has none. */
function slotsOf(node: BlockNode): Record<string, unknown> | null {
  const s = (node as { slots?: unknown }).slots
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : null
}

/**
 * Rebuild a block's `slots` bag, recursing each child array through `recurse`. Identity-preserving: a
 * slot whose populated children are each `===` the originals keeps the original array ref, and when NO
 * slot changed the whole bag is reported unchanged (`null`) — so the live preview never churns block
 * identities on an unaffected subtree. The `b === arr[i]` short-circuit is load-bearing for reactivity.
 */
function mapSlots(
  slots: Record<string, unknown> | null,
  recurse: (arr: unknown[]) => BlockNode[],
): Record<string, unknown> | null {
  if (!slots) return null
  const rebuilt: Record<string, unknown> = {}
  let changed = false
  for (const [name, arr] of Object.entries(slots)) {
    if (!Array.isArray(arr)) {
      rebuilt[name] = arr
      continue
    }
    const populated = recurse(arr)
    const same = populated.length === arr.length && populated.every((b, i) => b === arr[i])
    rebuilt[name] = same ? arr : populated
    if (!same) changed = true
  }
  return changed ? rebuilt : null
}

export interface LinkRef { collection: string; id: number }

/** The `{collection, id}` of an internal LinkValue, or null for external/email/tel/empty. */
function internalRefOf(value: unknown): LinkRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  return v.type === 'internal' && typeof v.collection === 'string' && typeof v.id === 'number'
    ? { collection: v.collection, id: v.id }
    : null
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Field-bag recursion — the client mirror of the server field-tree walker
// (`layers/fields/server/utils/field-populate.ts`). A "bag" is a block's props OR a repeater entry;
// both key media/link/richtext values BARE (props key-mode). Every collector/populator descends
// `repeater` sub-fields so a repeater-nested media/link resolves in the preview exactly as it does in
// the generated page — the two must stay in lock-step.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Media ids referenced by a value-bag (a block's props or a repeater entry), recursing repeater entries. */
function collectMediaFromBag(fields: Record<string, SerializedField>, bag: Record<string, unknown>, ids: Set<number>): void {
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === 'media') {
      const v = bag[key]
      if (field.options?.multiple) {
        if (Array.isArray(v)) for (const x of v) if (typeof x === 'number') ids.add(x)
      } else if (typeof v === 'number') {
        ids.add(v)
      }
    } else {
      const sub = repeaterFields(field)
      const entries = sub ? bag[key] : null
      if (sub && Array.isArray(entries)) {
        for (const e of entries) if (e && typeof e === 'object') collectMediaFromBag(sub, e as Record<string, unknown>, ids)
      }
    }
  }
}

/** Every media id referenced by block props (incl. repeater entries), deduped and walked into slot
 *  children — for one batched resolve call. */
export function collectMediaIds(blocks: unknown, byType: Record<string, SerializedBlock>): number[] {
  const ids = new Set<number>()
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes as BlockNode[]) {
      const def = node?.type ? byType[node.type] : undefined
      if (def && node.props) collectMediaFromBag(def.fields, node.props, ids)
      const slots = node ? slotsOf(node) : null
      if (slots) for (const arr of Object.values(slots)) walk(arr)
    }
  }
  walk(blocks)
  return [...ids]
}

/**
 * Populate media in a value-bag: attach a `$media` sibling for its direct media fields and recurse each
 * repeater entry. Identity-preserving — returns the SAME bag ref when nothing resolved and reuses each
 * unchanged repeater array/entry — so the preview doesn't churn identities on every recompute.
 */
function populateMediaInBag(
  fields: Record<string, SerializedField>,
  bag: Record<string, unknown>,
  resolve: (id: number) => ResolvedMedia | null,
): Record<string, unknown> {
  let media: Record<string, unknown> | null = null
  let repeaters: Record<string, unknown> | null = null
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === 'media') {
      const v = bag[key]
      if (field.options?.multiple) {
        if (Array.isArray(v)) {
          const resolved = v.filter((x): x is number => typeof x === 'number').map(resolve).filter((m): m is ResolvedMedia => !!m)
          if (resolved.length) (media ??= {})[key] = resolved
        }
      } else if (typeof v === 'number') {
        const m = resolve(v)
        if (m) (media ??= {})[key] = m
      }
    } else {
      const sub = repeaterFields(field)
      const entries = sub ? bag[key] : null
      if (sub && Array.isArray(entries)) {
        const populated = entries.map((e) => (e && typeof e === 'object' ? populateMediaInBag(sub, e as Record<string, unknown>, resolve) : e))
        if (!populated.every((e, i) => e === entries[i])) (repeaters ??= {})[key] = populated
      }
    }
  }
  if (!media && !repeaters) return bag
  const out = { ...bag }
  if (repeaters) Object.assign(out, repeaters)
  if (media) out.$media = media
  return out
}

/**
 * Client mirror of the server media populator: attach a `$media` bag to each block's props (and each
 * repeater entry) so the public `BlockRenderer` and `Blocks*` display components render images in the
 * live preview. Pure; `resolve` is the (reactive) id→media lookup. Recurses slot children AND repeater
 * entries. A block whose whole subtree needs no media (media-free, unknown type, empty/unchanged slots,
 * or not-yet-resolved ids) is returned **by reference** so unchanged branches keep their refs all the
 * way up.
 */
export function populateBlocksMedia(
  blocks: unknown,
  byType: Record<string, SerializedBlock>,
  resolve: (id: number) => ResolvedMedia | null,
): BlockNode[] {
  if (!Array.isArray(blocks)) return []
  return (blocks as BlockNode[]).map((node) => {
    const def = node?.type ? byType[node.type] : undefined
    const nextProps = def && node.props ? populateMediaInBag(def.fields, node.props, resolve) : node.props

    // Rebuild slots only where a child subtree actually changed; otherwise reuse the original array
    // ref so an empty or media-free slot doesn't force a new parent object.
    const nextSlots = mapSlots(node ? slotsOf(node) : null, (arr) => populateBlocksMedia(arr, byType, resolve))

    if (nextProps === node.props && !nextSlots) return node
    const out: BlockNode = { ...node }
    if (nextProps !== node.props) out.props = nextProps
    if (nextSlots) out.slots = nextSlots
    return out
  })
}

/** Internal-link + richtext-marker refs in a value-bag (a block's props or a repeater entry), recursing
 *  repeater entries. */
function collectLinkRefsFromBag(fields: Record<string, SerializedField>, bag: Record<string, unknown>, add: (ref: LinkRef) => void): void {
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === 'link') {
      const ref = internalRefOf(bag[key])
      if (ref) add(ref)
    } else if (field.type === 'richtext') {
      for (const ref of collectRichtextRefs(bag[key] as string | undefined)) add(ref)
    } else {
      const sub = repeaterFields(field)
      const entries = sub ? bag[key] : null
      if (sub && Array.isArray(entries)) {
        for (const e of entries) if (e && typeof e === 'object') collectLinkRefsFromBag(sub, e as Record<string, unknown>, add)
      }
    }
  }
}

/** Every internal-link `{collection,id}` referenced by block props (incl. repeater entries + richtext
 *  markers), deduped, walked into slots — for one batched resolve call (mirror of `collectMediaIds`). */
export function collectLinkRefs(blocks: unknown, byType: Record<string, SerializedBlock>): LinkRef[] {
  const seen = new Set<string>()
  const refs: LinkRef[] = []
  const add = (ref: LinkRef): void => {
    const k = `${ref.collection}:${ref.id}`
    if (!seen.has(k)) {
      seen.add(k)
      refs.push(ref)
    }
  }
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes as BlockNode[]) {
      const def = node?.type ? byType[node.type] : undefined
      if (def && node.props) collectLinkRefsFromBag(def.fields, node.props, add)
      const slots = node ? slotsOf(node) : null
      if (slots) for (const arr of Object.values(slots)) walk(arr)
    }
  }
  walk(blocks)
  return refs
}

/**
 * Resolve internal links + richtext markers in a value-bag, recursing repeater entries. Identity-
 * preserving — a link/richtext value that needs no change keeps its ref, an unchanged repeater array/
 * entry keeps its ref, and a bag with nothing to change is returned as-is (lazily cloned only on the
 * first actual change).
 */
function populateLinksInBag(
  fields: Record<string, SerializedField>,
  bag: Record<string, unknown>,
  resolveHref: (collection: string, id: number) => string | null,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === 'link') {
      const ref = internalRefOf(bag[key])
      if (!ref) continue
      const href = resolveHref(ref.collection, ref.id)
      const current = bag[key] as Record<string, unknown>
      if (href == null || current.href === href) continue
      ;(next ??= { ...bag })[key] = { ...current, href }
    } else if (field.type === 'richtext') {
      const current = bag[key]
      if (typeof current !== 'string') continue
      const resolved = resolveRichtextLinks(current, resolveHref)
      if (resolved === current) continue // no markers (or already identical) → keep ref
      ;(next ??= { ...bag })[key] = resolved
    } else {
      const sub = repeaterFields(field)
      const entries = sub ? bag[key] : null
      if (sub && Array.isArray(entries)) {
        const populated = entries.map((e) => (e && typeof e === 'object' ? populateLinksInBag(sub, e as Record<string, unknown>, resolveHref) : e))
        if (!populated.every((e, i) => e === entries[i])) (next ??= { ...bag })[key] = populated
      }
    }
  }
  return next ?? bag
}

/**
 * Client mirror of the server link populator: replace each block's internal-link field value with a
 * cloned `{...value, href}` (and rewrite richtext markers) so the live preview's `KestrelLink` renders
 * the real path instead of `'#'`. external/email/tel and unresolved internals are left untouched.
 * Recurses slot children AND repeater entries. Identity-preserving like `populateBlocksMedia` — a block
 * (and its slot/repeater subtree) whose links need no change is returned by reference.
 */
export function populateBlocksLinks(
  blocks: unknown,
  byType: Record<string, SerializedBlock>,
  resolveHref: (collection: string, id: number) => string | null,
): BlockNode[] {
  if (!Array.isArray(blocks)) return []
  return (blocks as BlockNode[]).map((node) => {
    const def = node?.type ? byType[node.type] : undefined
    const nextProps = def && node.props ? populateLinksInBag(def.fields, node.props, resolveHref) : node.props

    const nextSlots = mapSlots(node ? slotsOf(node) : null, (arr) => populateBlocksLinks(arr, byType, resolveHref))

    if (nextProps === node.props && !nextSlots) return node
    const out: BlockNode = { ...node }
    if (nextProps !== node.props) out.props = nextProps
    if (nextSlots) out.slots = nextSlots
    return out
  })
}
