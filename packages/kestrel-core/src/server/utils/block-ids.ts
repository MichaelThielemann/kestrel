import { randomUUID } from 'node:crypto'

// Server-side twin of the admin's `cloneBlockTree` (layers/admin/app/utils/block-tree.ts): re-mint every
// block id at every slot depth, preserving type / props / structure. This is a DELIBERATE crossing-free
// duplication, NOT a reshape: `cloneBlockTree` lives in the ADMIN (client) layer and is unreachable from a
// server layer, so the record-duplicate operation gets its own pure, node-tested helper here in `fields`
// (the block-content-shape home) rather than inverting the layer dependency. No field-def dependency — a
// plain traversal of the `{ id, type, props?, slots? }` node shape — so it unit-tests hard.

type GenId = () => string

interface BlockNode {
  id: string
  type: string
  props?: Record<string, unknown>
  slots?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Return a copy of a block `content` array with a FRESH id on every node at every slot depth, so a
 * duplicated record never shares block identity with its source (the id-addressed tree, error addressing
 * and per-record edit state all rely on ids being unique per record). Props and slot structure are deep-
 * cloned and preserved verbatim. A non-array `content` (or a non-object node) passes through untouched.
 * `genId` is injectable for deterministic tests; it defaults to `crypto.randomUUID`.
 * @public
 */
export function regenerateBlockIds(content: unknown, genId: GenId = randomUUID): unknown {
  if (!Array.isArray(content)) return content
  return content.map((node) => cloneNode(node, genId))
}

function cloneNode(node: unknown, genId: GenId): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const n = node as BlockNode
  const copy: BlockNode = { ...n, id: genId() }
  if (n.props && typeof n.props === 'object') copy.props = structuredClone(n.props)
  if (n.slots && typeof n.slots === 'object' && !Array.isArray(n.slots)) {
    copy.slots = Object.fromEntries(
      Object.entries(n.slots).map(([name, arr]) => [name, Array.isArray(arr) ? arr.map((c) => cloneNode(c, genId)) : arr]),
    )
  }
  return copy
}
