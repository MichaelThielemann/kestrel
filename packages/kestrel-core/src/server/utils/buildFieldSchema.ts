import type { ZodType } from 'zod'
import type { FieldDef } from './defineCollection.js'
import { getFieldType } from '../registries/field-types.js'
import { resolveColumnName } from './naming.js'

function buildShape(fields: Record<string, FieldDef>, keyOf: (key: string, field: FieldDef) => string): Record<string, ZodType> {
  const out: Record<string, ZodType> = {}
  for (const [key, field] of Object.entries(fields)) {
    out[keyOf(key, field)] = getFieldType(field.type).validator(field)
  }
  return out
}

/** Collection columns: keyed by jsKey (matches buildTable's column keys).
 * @public
 */
export function buildFieldSchema(fields: Record<string, FieldDef>): Record<string, ZodType> {
  return buildShape(fields, (key, field) => resolveColumnName(key, field).jsKey)
}

/** Block props: keyed by the raw field name (props are not DB columns).
 * @public
 */
export function buildFieldObjectSchema(fields: Record<string, FieldDef>): Record<string, ZodType> {
  return buildShape(fields, (key) => key)
}
