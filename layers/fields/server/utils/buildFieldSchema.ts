import type { ZodType } from 'zod'
import type { FieldDef } from '../../../core/server/utils/defineCollection'
import { getFieldType } from '../field-registry'
import { resolveColumnName } from '../field-registry/naming'

function buildShape(fields: Record<string, FieldDef>, keyOf: (key: string, field: FieldDef) => string): Record<string, ZodType> {
  const out: Record<string, ZodType> = {}
  for (const [key, field] of Object.entries(fields)) {
    out[keyOf(key, field)] = getFieldType(field.type).validator(field)
  }
  return out
}

/** Collection columns: keyed by jsKey (matches buildTable's column keys). */
export function buildFieldSchema(fields: Record<string, FieldDef>): Record<string, ZodType> {
  return buildShape(fields, (key, field) => resolveColumnName(key, field).jsKey)
}

/** Block props: keyed by the raw field name (props are not DB columns). */
export function buildFieldObjectSchema(fields: Record<string, FieldDef>): Record<string, ZodType> {
  return buildShape(fields, (key) => key)
}
