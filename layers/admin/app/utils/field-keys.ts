import type { SerializedField } from '@michaelthielemann/kestrel-core'

/**
 * The jsKey (wire key) for a field — NOT a DB column name. The server marks single relation/media fields
 * with `single` (stored as a `<name>Id` FK column, e.g. `author` -> `authorId`); everything else keeps the
 * field name. The editor binds widgets by field name but must read/write rows, request bodies and list
 * queries by this key — reading the server flag instead of re-deriving the rule (which silently drifts).
 */
export function jsKey(name: string, field: SerializedField): string {
  return field.single ? `${name}Id` : name
}
