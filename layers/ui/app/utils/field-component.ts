import type { FieldDef } from '@kestrel/core'

/** A record reference: its id plus a human label. Shared by UiCombobox and FieldRelation. */
export interface FieldOption { value: number; label: string }

/**
 * The shared prop contract every Field* widget honors (plus a v-model).
 *
 * Validity vocabulary (two intentional names, one seam): `error: string | null` is the validation
 * MESSAGE, carried by the wrappers (UiField/UiFieldset) which own its display + aria-describedby. A few
 * portaled controls that render outside the wrapper (UiCombobox, FieldLinkInternalPicker) also take an
 * `invalid: boolean` — just the visual ring — because they can't see the wrapper's `[data-invalid]`.
 * So: `error` = the message at the field boundary; `invalid` = the ring for detached/teleported controls.
 */
export interface FieldComponentProps {
  field: FieldDef
  name: string
  locale: string
  error?: string | null
  disabled?: boolean
  id?: string
}
