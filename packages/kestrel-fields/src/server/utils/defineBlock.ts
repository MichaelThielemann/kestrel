import type { BlockDef } from '@kestrel/core'

export type { BlockDef }
// The block registry itself lives in `@kestrel/core` (core's pipeline and schema engine need it directly,
// and core cannot depend on fields) — re-exported here alongside this file's own `defineBlock` so a block
// author gets both from the one `@kestrel/fields` import.
export { registerBlock, getBlock, clearBlocks, allBlocks, buildBlocksSchema } from '@kestrel/core'

/** Identity helper for a block SFC's `defineBlock({...})` call — purely a type-checking touchpoint (the
 *  actual registration is `registerBlock`, called by the auto-discovery plugin with the extracted def).
 * @public
 */
export function defineBlock(def: BlockDef): BlockDef {
  return def
}
