import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { z } from 'zod'
import type { CollectionDef } from './defineCollection'

/** The validation schemas are loose `ZodObject`s. drizzle-zod's builders are overloaded such that
 *  `ReturnType<typeof createInsertSchema>` resolves to the WRONG (ZodEnum) overload, so the shape is stated
 *  directly — `ZodObject` carries the `.safeParse()` / `.partial()` the CRUD layer calls; `buildCollection`
 *  casts the builder results to it. */
export type CollectionSchema = z.ZodObject<z.ZodRawShape>

export interface ConditionIssue {
  path: (string | number)[]
  message: string
}

export interface BuiltCollection {
  name: string
  def: CollectionDef
  table: SQLiteTable
  insert: CollectionSchema
  update: CollectionSchema
  select: CollectionSchema
  /** Re-enforce `required` for conditional fields whose condition is met against the whole record
   *  (the per-field schema can't see siblings). Returns Zod-shaped issues keyed by the field's def
   *  name. Present only when the collection has conditional required fields. */
  applyConditions?: (record: Record<string, unknown>) => { issues: ConditionIssue[] }
}
