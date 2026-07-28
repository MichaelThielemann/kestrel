import { isSingleRefColumn, type FieldDef } from '../../../core/server/utils/defineCollection'

export function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
}

export function resolveColumnName(key: string, field: FieldDef): { jsKey: string; dbName: string } {
  if (isSingleRefColumn(field)) return { jsKey: `${key}Id`, dbName: `${toSnakeCase(key)}_id` }
  return { jsKey: key, dbName: toSnakeCase(key) }
}
