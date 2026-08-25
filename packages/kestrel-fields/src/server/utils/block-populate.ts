import type { FieldDef } from '@kestrel/core'
import { getBlock } from './defineBlock.js'

/** A per-block-props mutation: populate/resolve one block's props in place, given its field defs.
 * @public
 */
export type ApplyBlockFields = (props: Record<string, unknown>, fields: Record<string, FieldDef>) => void

/**
 * The shared block-content walker for server-side populators (media `$media`, internal-link resolution,
 * …). Maps a `content` array, deep-cloning each block node, applying `applyFields` to a clone of its
 * `props` (block type looked up via the registry), and recursing into every declared slot. The differing
 * per-field work lives in `applyFields`; only this clone-and-recurse traversal is shared. Returns a fresh
 * array (server populators hand back new rows); nodes that aren't block objects pass through untouched.
 * @public
 */
export function buildBlockPopulator(applyFields: ApplyBlockFields): (nodes: unknown) => unknown[] {
  const walk = (nodes: unknown): unknown[] => {
    if (!Array.isArray(nodes)) return []
    return nodes.map((node) => {
      if (!node || typeof node !== 'object') return node
      const original = node as { type?: string; props?: Record<string, unknown>; slots?: Record<string, unknown> }
      const cloned: Record<string, unknown> = { ...original }

      const blockDef = original.type ? getBlock(original.type) : undefined
      if (blockDef && original.props) {
        const props: Record<string, unknown> = { ...original.props }
        cloned.props = props
        applyFields(props, blockDef.fields)
      }

      if (original.slots && typeof original.slots === 'object') {
        const slots: Record<string, unknown> = {}
        for (const [slotName, slotNodes] of Object.entries(original.slots)) {
          slots[slotName] = walk(slotNodes)
        }
        cloned.slots = slots
      }

      return cloned
    })
  }
  return walk
}
