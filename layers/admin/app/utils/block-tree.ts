import type { SerializedBlock } from '../../../core/server/utils/serialize-collection'
import { reorder } from '../../../ui/app/utils/reorder'
import { initialValues } from './edit-form'

// Pure, immutable operations over a nested block tree (`content`), addressed by each block's stable
// `id` rather than a positional index — this is what lets a single shared selection + one fields pane
// edit a block at ANY depth: every op walks the whole tree by id and rebuilds only the path to it. No
// Vue here — fully unit-testable.

export interface BlockRow {
  id: string
  type: string
  props: Record<string, unknown>
  slots?: Record<string, unknown>
}

type GenId = () => string

/** Stable config + id-addressed operations for the tree pane, threaded through the recursion as one
 *  object. Lives here (not in the SFC) so the component, the editor shell, and tests can share the type. */
export interface BlockTreeCtx {
  byName: Record<string, SerializedBlock>
  allowedTypes: SerializedBlock[]
  ops: {
    select: (id: string | null) => void
    add: (parentId: string | null, slotName: string | null, type: string) => void
    remove: (id: string) => void
    move: (id: string, dir: -1 | 1) => void
    duplicate: (id: string) => void
  }
}

/** A seeded blank block of `type`: fresh id + props defaulted from the type's field schema. */
export function blankBlock(type: string, schemas: Record<string, SerializedBlock>, genId: GenId): BlockRow {
  return { id: genId(), type, props: initialValues(schemas[type]?.fields ?? {}) }
}

/** Deep-clone a block subtree with fresh ids at every level (duplicate never shares an id or a ref). */
export function cloneBlockTree(b: BlockRow, genId: GenId): BlockRow {
  const copy: BlockRow = { ...b, id: genId(), props: JSON.parse(JSON.stringify(b.props ?? {})) }
  if (b.slots) {
    copy.slots = Object.fromEntries(
      Object.entries(b.slots).map(([name, arr]) => [name, Array.isArray(arr) ? (arr as BlockRow[]).map((c) => cloneBlockTree(c, genId)) : arr]),
    )
  }
  return copy
}

export interface Found {
  block: BlockRow
  /** The array that directly contains the block. */
  siblings: BlockRow[]
  index: number
  /** The id of the block whose slot contains this one, or null at the root level. */
  parentId: string | null
  /** The slot name this block lives in, or null at the root level. */
  slotName: string | null
}

/** Locate a block anywhere in the tree by id (with its container + position), or null. */
export function findInTree(blocks: BlockRow[], id: string): Found | null {
  function walk(arr: BlockRow[], parentId: string | null, slotName: string | null): Found | null {
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i]!
      if (b.id === id) return { block: b, siblings: arr, index: i, parentId, slotName }
      if (b.slots) {
        for (const [name, sub] of Object.entries(b.slots)) {
          if (Array.isArray(sub)) {
            const hit = walk(sub as BlockRow[], b.id, name)
            if (hit) return hit
          }
        }
      }
    }
    return null
  }
  return walk(blocks, null, null)
}

/** Immutably transform the block with `id` (block → new block), rebuilding ONLY the path to it; every
 *  untouched block AND array keeps its reference. Returning the original `blocks` when nothing changed is
 *  what makes the recursive `next !== sub` a correct change-detector (a bare `.map` always allocates, so it
 *  would rebuild every slot-bearing block in the tree on any edit). */
function updateBlock(blocks: BlockRow[], id: string, fn: (b: BlockRow) => BlockRow): BlockRow[] {
  let changed = false
  const out = blocks.map((b) => {
    if (b.id === id) { changed = true; return fn(b) }
    if (!b.slots) return b
    const mapped = withMappedSlots(b)
    if (mapped !== b) changed = true
    return mapped
  })
  return changed ? out : blocks
  function withMappedSlots(b: BlockRow): BlockRow {
    let changed = false
    const slots: Record<string, unknown> = {}
    for (const [name, sub] of Object.entries(b.slots!)) {
      if (Array.isArray(sub)) {
        const next = updateBlock(sub as BlockRow[], id, fn)
        if (next !== sub) changed = true
        slots[name] = next
      } else slots[name] = sub
    }
    return changed ? { ...b, slots } : b
  }
}

/** Immutably transform the ARRAY that directly contains `id` (array+index → new array); every untouched
 *  block AND array keeps its reference (same same-ref-when-unchanged rule as `updateBlock`). */
function updateContaining(blocks: BlockRow[], id: string, fn: (arr: BlockRow[], index: number) => BlockRow[]): BlockRow[] {
  const idx = blocks.findIndex((b) => b.id === id)
  if (idx !== -1) return fn(blocks, idx)
  let changed = false
  const out = blocks.map((b) => {
    if (!b.slots) return b
    let slotChanged = false
    const slots: Record<string, unknown> = {}
    for (const [name, sub] of Object.entries(b.slots)) {
      if (Array.isArray(sub)) {
        const next = updateContaining(sub as BlockRow[], id, fn)
        if (next !== sub) slotChanged = true
        slots[name] = next
      } else slots[name] = sub
    }
    if (!slotChanged) return b
    changed = true
    return { ...b, slots }
  })
  return changed ? out : blocks
}

export function updatePropById(blocks: BlockRow[], id: string, key: string, value: unknown): BlockRow[] {
  return updateBlock(blocks, id, (b) => ({ ...b, props: { ...b.props, [key]: value } }))
}

/** Remove the block with `id` from wherever it lives. */
export function removeById(blocks: BlockRow[], id: string): BlockRow[] {
  return updateContaining(blocks, id, (arr, i) => arr.filter((_, j) => j !== i))
}

/** Where selection should move when the block with `id` is removed: previous sibling, else next, else
 *  the parent (null at the root). Computed against the tree BEFORE removal. */
export function removalRetarget(blocks: BlockRow[], id: string): string | null {
  const f = findInTree(blocks, id)
  if (!f) return null
  if (f.index > 0) return f.siblings[f.index - 1]!.id
  if (f.index < f.siblings.length - 1) return f.siblings[f.index + 1]!.id
  return f.parentId
}

/** Move the block with `id` one step within its container (`dir` -1 up / +1 down); clamps at the edges. */
export function moveById(blocks: BlockRow[], id: string, dir: -1 | 1): BlockRow[] {
  return updateContaining(blocks, id, (arr, i) => {
    const to = i + dir
    if (to < 0 || to >= arr.length) return arr
    return reorder(arr, i, to)
  })
}

/** Duplicate the block with `id` (fresh ids throughout) right after it; returns the new tree + new id. */
export function duplicateById(blocks: BlockRow[], id: string, genId: GenId): { tree: BlockRow[]; newId: string } {
  let newId = ''
  const tree = updateContaining(blocks, id, (arr, i) => {
    const copy = cloneBlockTree(arr[i]!, genId)
    newId = copy.id
    const next = [...arr]
    next.splice(i + 1, 0, copy)
    return next
  })
  return { tree, newId }
}

/** Append a seeded block of `type` at the root (`parentId` null) or into a parent's slot; returns the
 *  new tree + the new block's id. */
export function addBlock(
  blocks: BlockRow[],
  parentId: string | null,
  slotName: string | null,
  type: string,
  schemas: Record<string, SerializedBlock>,
  genId: GenId,
): { tree: BlockRow[]; newId: string } {
  const block = blankBlock(type, schemas, genId)
  if (parentId === null || slotName === null) return { tree: [...blocks, block], newId: block.id }
  const tree = updateBlock(blocks, parentId, (parent) => {
    const cur = Array.isArray(parent.slots?.[slotName]) ? (parent.slots![slotName] as BlockRow[]) : []
    return { ...parent, slots: { ...(parent.slots ?? {}), [slotName]: [...cur, block] } }
  })
  return { tree, newId: block.id }
}

/** Ids of every block that itself has an error OR has a descendant with one (ancestor roll-up), for
 *  tree badges. `directIds` are the blocks the error map keys directly. */
export function errorBearingIds(blocks: BlockRow[], directIds: Set<string>): Set<string> {
  const out = new Set<string>()
  function walk(arr: BlockRow[]): boolean {
    let any = false
    for (const b of arr) {
      let descendantHasError = false
      if (b.slots) {
        for (const sub of Object.values(b.slots)) {
          if (Array.isArray(sub) && walk(sub as BlockRow[])) descendantHasError = true
        }
      }
      if (directIds.has(b.id) || descendantHasError) {
        out.add(b.id)
        any = true
      }
    }
    return any
  }
  walk(blocks)
  return out
}
