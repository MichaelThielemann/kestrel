import { computed, useId, type ComputedRef } from 'vue'

interface FieldA11yProps {
  hint?: string
  error?: string | null
  required?: boolean
  id?: string
}

interface FieldA11y {
  fieldId: ComputedRef<string>
  hintId: ComputedRef<string>
  errId: ComputedRef<string>
  describedby: ComputedRef<string | undefined>
  ariaInvalid: ComputedRef<'true' | undefined>
  ariaRequired: ComputedRef<'true' | undefined>
}

/**
 * Shared accessibility wiring for labelled controls (UiField) and grouped controls (UiFieldset):
 * a stable id, hint/error ids, the aria-describedby join, and aria-invalid. One source so the
 * describedby ordering and aria contract cannot drift between the two.
 */
export function useFieldA11y(props: FieldA11yProps): FieldA11y {
  const auto = useId()
  const fieldId = computed(() => props.id ?? auto)
  const hintId = computed(() => `${fieldId.value}-hint`)
  const errId = computed(() => `${fieldId.value}-error`)
  const describedby = computed(() => {
    const ids: string[] = []
    if (props.hint) ids.push(hintId.value)
    if (props.error) ids.push(errId.value)
    return ids.length ? ids.join(' ') : undefined
  })
  const ariaInvalid = computed(() => (props.error ? 'true' : undefined))
  // Grouped/non-native controls (role=group, teleported widgets) get required conveyed via aria-required,
  // since the visual asterisk is aria-hidden and a bare `required` attr on a non-input is ignored by AT.
  const ariaRequired = computed(() => (props.required ? 'true' : undefined))
  return { fieldId, hintId, errId, describedby, ariaInvalid, ariaRequired }
}
