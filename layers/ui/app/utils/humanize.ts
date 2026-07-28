/**
 * Turn a field key into a human label: split snake_case / kebab-case / camelCase into words and
 * capitalize the first. The shared fallback when a field has no explicit (localized) `label`, used by
 * both the editor field widgets (via the FieldRenderer) and the collection-list column headers — so the
 * editor label and the list header read the same.
 */
export function humanizeFieldName(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name
}
