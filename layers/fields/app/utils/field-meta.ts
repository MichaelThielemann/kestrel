import type { FieldDef, FieldOf } from '../../../core/server/utils/defineCollection'
import { numberIsInteger } from './field-constraints'

export interface FieldConstraints {
  required: boolean
  minlength?: number
  maxlength?: number
  min?: number
  max?: number
  step?: number | 'any'
  multiline?: boolean
}

/** Input-relevant attributes derived from a FieldDef, for the field widgets. */
export function fieldConstraints(field: FieldDef): FieldConstraints {
  const c: FieldConstraints = { required: !!field.required }
  // `field as FieldOf<'x'>`: the open consumer arm makes `type` a non-discriminant, so `field.type === 'x'`
  // doesn't narrow `field` — the cast applies the arm the guard just proved. (App-side: type-only, no
  // runtime import of the server-side `fieldIs` guard into the client bundle.)
  if (field.type === 'text') {
    const f = field as FieldOf<'text'>
    if (f.options?.minLength !== undefined) c.minlength = f.options.minLength
    if (f.options?.maxLength !== undefined) c.maxlength = f.options.maxLength
    if (f.options?.multiline) c.multiline = true
  } else if (field.type === 'number') {
    const f = field as FieldOf<'number'>
    if (f.options?.min !== undefined) c.min = f.options.min
    if (f.options?.max !== undefined) c.max = f.options.max
    if (f.options?.decimals !== undefined) c.step = 1 / 10 ** f.options.decimals
    else c.step = numberIsInteger(f.options) ? 1 : 'any'
  }
  return c
}
