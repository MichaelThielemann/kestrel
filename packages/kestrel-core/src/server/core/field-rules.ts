import { fieldIs, type FieldDef } from '../utils/defineCollection.js'

/** Whether `field.required` should be enforced at the column/validator level. A conditional field is only
 *  `required` when its condition is met — which the per-column / per-field schema can't see (no sibling
 *  access) — so it is never enforced here: the column stays nullable and the validator stays optional; the
 * @public
 *  whole-record `applyConditions` hook re-enforces required-when-visible. */
export function isHardRequired(field: FieldDef): boolean {
  return !!field.required && !field.condition
}

/** Whether `field.unique` actually reaches a DB constraint for THIS field (options-dependent, not just
 *  type-dependent — a `choice`/`media` field is only json-backed when `multiple`, a `relation` only when
 *  `many`). Mirrors the field-type registry's `column()` arms exactly: the json/array-backed arms never
 *  apply a column-level unique constraint, so `unique: true` there is a silent no-op, not a soft hint.
 * @public
 *  `buildTable` uses this to fail loud at collection-build time instead. */
export function fieldCanEnforceUnique(field: FieldDef): boolean {
  // `fieldIs` not `switch`: the open consumer arm makes `type` a non-discriminant (no switch narrowing).
  if (fieldIs(field, 'choice')) return !field.options.multiple
  if (fieldIs(field, 'media')) return !field.options?.multiple
  if (fieldIs(field, 'relation')) return !field.relation.many
  if (fieldIs(field, 'repeater')) return false
  if (fieldIs(field, 'json')) return false
  return true
}
