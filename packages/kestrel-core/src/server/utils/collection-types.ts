import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { z } from 'zod'
import type { CollectionDef } from './defineCollection.js'

/** The validation schemas are loose `ZodObject`s. drizzle-zod's builders are overloaded such that
 *  `ReturnType<typeof createInsertSchema>` resolves to the WRONG (ZodEnum) overload, so the shape is stated
 *  directly — `ZodObject` carries the `.safeParse()` / `.partial()` the CRUD layer calls; `buildCollection`
 * @public
 *  casts the builder results to it. */
export type CollectionSchema = z.ZodObject<z.ZodRawShape>

/** @public */
export interface ConditionIssue {
  path: (string | number)[]
  message: string
}

/** @public */
export interface BuiltCollection {
  name: string
  def: CollectionDef
  table: SQLiteTable
  insert: CollectionSchema
  update: CollectionSchema
  select: CollectionSchema
  /** Every pre-write check the per-field schema can't do because it sees one field at a time: `required`
   *  re-enforced for conditional fields whose condition is met against the whole record, plus the
   *  collection's own `def.validate`. Returns Zod-shaped issues keyed by the field's def name. Present
   *  only when the collection has conditional required fields or a `validate`. */
  applyConditions?: (record: Record<string, unknown>) => { issues: ConditionIssue[] }
}
