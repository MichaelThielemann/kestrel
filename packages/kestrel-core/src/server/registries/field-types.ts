import type { SQLiteColumnBuilderBase } from 'drizzle-orm/sqlite-core'
import type { ZodType } from 'zod'
import type { FieldOf, FieldType } from '../utils/defineCollection.js'

/** Descriptor for a field `type`. Generic over the type name so a built-in descriptor's body receives its
 *  SPECIFIC `FieldDef` arm (`FieldOf<'text'>` etc.) — the registry can't discriminate the union itself
 *  (the open consumer arm makes `type` a non-discriminant). The default `T = FieldType` widens `field` back
 * @public
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

/** The live field-type registry: seeded once with the built-in set (`seedBuiltinFieldTypes`, called by
 *  `kestrel-fields` at module load), extended in place by `registerFieldType`. `getFieldType` is the read
 *  side; prefer it over reading this map directly, since a consumer registration can replace an entry
 *  after collections have already been defined against it. Exported (not module-private) only so
 * @public
 *  `kestrel-fields`'s own tests can assert against the live set built-ins land in. */
export const fieldTypes: Record<string, FieldTypeDescriptor> = {}

/** The names Kestrel ships built-in (captured by `seedBuiltinFieldTypes`, before any consumer
 *  registration). */
let builtinFieldTypes = new Set<string>()

/** Seed the registry's baseline built-in set. Bypasses the override warning (these are the baseline, not
 *  an override) and records their names for `registerFieldType`'s later "overrides a built-in" check.
 * @public
 *  Called exactly once, by `kestrel-fields` at module load. */
export function seedBuiltinFieldTypes(entries: Record<string, FieldTypeDescriptor>): Record<string, FieldTypeDescriptor> {
  Object.assign(fieldTypes, entries)
  builtinFieldTypes = new Set(Object.keys(entries))
  // Returning the mutated registry (not `void`) gives `kestrel-fields` a genuine data dependency on this
  // call to export — a bundler can prove a pure re-export of the untouched `fieldTypes` declaration
  // doesn't need this call, but it cannot prove that about a value it must actually compute.
  return fieldTypes
}

/** Register a consumer-defined field type (via `defineFieldType`). Later registration wins, but never
 *  silently: a bad descriptor throws a clear error at registration (not a cryptic TypeError when a table is
 *  later built), and ANY re-registration of an existing name warns — overriding a built-in, or one extension
 * @public
 *  clobbering another's same-named type. */
export function registerFieldType(name: string, descriptor: FieldTypeDescriptor): void {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('[kestrel] registerFieldType: name must be a non-empty string')
  }
  if (typeof descriptor?.column !== 'function') {
    throw new Error(`[kestrel] registerFieldType("${name}"): descriptor.column must be a function`)
  }
  if (typeof descriptor?.validator !== 'function') {
    throw new Error(`[kestrel] registerFieldType("${name}"): descriptor.validator must be a function`)
  }
  if (descriptor.transform !== undefined && typeof descriptor.transform !== 'function') {
    throw new Error(`[kestrel] registerFieldType("${name}"): descriptor.transform must be a function if provided`)
  }
  // Object.hasOwn, not `in`: a field type named 'constructor'/'toString'/… would otherwise match an
  // inherited Object.prototype member (a spurious "re-registered" warning, and below a truthy lookup).
  if (Object.hasOwn(fieldTypes, name)) {
    console.warn(builtinFieldTypes.has(name)
      ? `[kestrel] field type "${name}" overrides a built-in`
      : `[kestrel] field type "${name}" re-registered — the previous definition was overwritten`)
  }
  fieldTypes[name] = descriptor
}

/** Look up a field-type descriptor, with a clear error for an unknown / unregistered type.
 * @public
 */
export function getFieldType(type: string): FieldTypeDescriptor {
  // Object.hasOwn guards the prototype chain: getFieldType('constructor') must throw the clear error, not
  // return Object.prototype.constructor and then crash with `.column is not a function` at table build.
  if (!Object.hasOwn(fieldTypes, type)) {
    throw new Error(`[kestrel] unknown field type "${type}" — register it with defineFieldType in server/field-types/`)
  }
  return fieldTypes[type]
}
