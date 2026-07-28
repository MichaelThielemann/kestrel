/**
 * Map a ButtonGroup (single-select ToggleGroup) selection to the boolean model. A deselect — reka emits
 * null/undefined when the already-active option is re-clicked — keeps the current value instead of
 * coercing to `false`, so re-clicking the selected option is a no-op rather than a silent inversion.
 */
export function nextBooleanValue(current: boolean | undefined, incoming: string | string[] | null): boolean | undefined {
  if (incoming === 'true') return true
  if (incoming === 'false') return false
  return current
}
