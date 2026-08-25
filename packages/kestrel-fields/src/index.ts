/**
 * Kestrel's built-in field-type descriptors, the block-definition helper, and the field/block content-
 * population walkers. Depends on `@kestrel/core` for the registries and content-model types; core never
 * depends back (the package graph is acyclic by design). Server-only entry — browser-safe pieces (consumed
 * directly by admin/ui components) are re-exported from `@kestrel/fields/client` instead.
 *
 * @packageDocumentation
 */

export { constrain, opt, optArr, fieldTypes } from './server/field-registry/index.js'
export {
  registerBlock, getBlock, clearBlocks, allBlocks, buildBlocksSchema, defineBlock, type BlockDef,
} from './server/utils/defineBlock.js'
export { defineFieldType, type FieldTypeDef, type FieldTypeDescriptor } from './server/utils/defineFieldType.js'
export {
  applyFieldPopulators, buildFieldTreePopulator, type PopulatorLookup,
} from './server/utils/field-populate.js'
export { buildBlockPopulator, type ApplyBlockFields } from './server/utils/block-populate.js'
export { buildBlocksPipelines } from './server/pipelines/blocks.js'
