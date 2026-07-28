import type { SQLiteColumnBuilderBase } from 'drizzle-orm/sqlite-core'
import type { ZodType } from 'zod'
import type { FieldOf, FieldType } from '../../../core/server/utils/defineCollection'

/** Descriptor for a field `type`. Generic over the type name so a built-in descriptor's body receives its
 *  SPECIFIC `FieldDef` arm (`FieldOf<'text'>` etc.) — the registry can't discriminate the union itself
 *  (the open consumer arm makes `type` a non-discriminant). The default `T = FieldType` widens `field` back
 *  to the full union for the registry's storage type + consumer-registered descriptors. */
export interface FieldTypeDescriptor<T extends FieldType = FieldType> {
  /** The ONLY place a Drizzle column type is decided. Pure; no Nitro/DB. */
  column(dbName: string, field: FieldOf<T>): SQLiteColumnBuilderBase
  /** Complete, optionality-aware Zod for the field value (drop-in replacement schema). */
  validator(field: FieldOf<T>): ZodType
  /** Optional write-time derivation: given this field's (validated) value, the whole record, and the field
   *  def, return the value to persist — e.g. a slug auto-generated from another field when left blank. Runs
   *  on create/update AFTER validation, BEFORE insert. Pure (no DB/Nitro); cross-field reads come from
   *  `record`. */
  transform?(value: unknown, record: Record<string, unknown>, field: FieldOf<T>): unknown
}
