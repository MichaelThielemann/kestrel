import { isSingleRefColumn, type FieldDef } from './defineCollection.js'

/** @public */
export function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
}

/** @public */
export function resolveColumnName(key: string, field: FieldDef): { jsKey: string; dbName: string } {
  if (isSingleRefColumn(field)) return { jsKey: `${key}Id`, dbName: `${toSnakeCase(key)}_id` }
  return { jsKey: key, dbName: toSnakeCase(key) }
}
