/**
 * Per-type blank-value registry for consumer-defined field types — consulted by the editor's form-init
 * (`emptyForField` in admin/edit-form). A custom array/object-backed type registers its empty here so a
 * NEW record / block seeds the right shape instead of `null`. Client-side + co-located with
 * `registerFieldComponent` (form-init is a client concern; the server descriptor can't reach it). No Vue
 * imports, so it is safe to import from the node-tested edit-form util.
 *
 * @example
 * // app/plugins/field-types.client.ts
 * registerFieldComponent('tags', TagsField)
 * registerFieldEmpty('tags', () => [])   // a new record seeds [] instead of null
 */
const fieldEmpties: Record<string, () => unknown> = {}

export function registerFieldEmpty(type: string, make: () => unknown): void {
  fieldEmpties[type] = make
}

export function resolveFieldEmpty(type: string): (() => unknown) | undefined {
  return fieldEmpties[type]
}
