import type { FieldDef } from '@michaelthielemann/kestrel-core'

type NumberOptions = Extract<FieldDef, { type: 'number' }>['options']
type ChoiceOptions = Extract<FieldDef, { type: 'choice' }>['options']

/**
 * Whether a number field is integer-valued — the default — i.e. neither
 * `integer: false` nor a `decimals` precision opts it into reals.
 */
export function numberIsInteger(options: NumberOptions): boolean {
  return options?.integer !== false && options?.decimals === undefined
}

/** The allowed values of a choice field, as a non-empty tuple (for `z.enum`). */
export function choiceValues(options: ChoiceOptions): [string, ...string[]] {
  return options.choices.map((c) => c.value) as [string, ...string[]]
}
