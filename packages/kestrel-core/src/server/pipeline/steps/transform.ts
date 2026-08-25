import { Effect } from 'effect'
import { getBlock, getFieldType } from '@kestrel/core'
import type { BuiltCollection } from '@kestrel/core'
import { applyFieldTransforms as applyFieldTransformsCore, type TransformLookups } from '../core/validate.js'
import { collectionOf, isSingletonWrite, unitsOf, type Row } from './shared.js'
import { syncStep, type StepDef } from '../types.js'

const lookups: TransformLookups = {
  getTransform: (type) => getFieldType(type).transform,
  getBlockFields: (blockType) => getBlock(blockType)?.fields,
}

/** `crud.ts` re-exports this under the mutate-in-place, collection-taking shape existing callers (and
 *  `crud.transform.test.ts`) already depend on — the core (`core/validate.ts`) is pure: it takes the
 * @public
 *  field-registry lookups as data and RETURNS the transformed values instead of writing into `values`. */
export function applyFieldTransforms(c: BuiltCollection, values: Row, record: Row, all: boolean): void {
  Object.assign(values, applyFieldTransformsCore(lookups, c.def.fields, c.def.blocks?.enabled, values, record, all))
}

/** @public */
export function transformStep(kind: 'create' | 'update'): StepDef {
  return syncStep('transform', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    for (const unit of unitsOf(ctx)) {
      if (kind === 'create') {
        applyFieldTransforms(c, unit.values, unit.values, true)
        continue
      }
      // A first singleton PUT has no existing row, so every transforming field runs (like a create);
      // a regular update of a missing row transforms nothing — it 404s at `persist`.
      if (unit.before) applyFieldTransforms(c, unit.values, { ...unit.before, ...unit.values }, false)
      else if (isSingletonWrite(ctx)) applyFieldTransforms(c, unit.values, unit.values, true)
    }
  }))
}
