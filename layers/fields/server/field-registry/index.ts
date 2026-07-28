import { integer, real, text } from 'drizzle-orm/sqlite-core'
import type { SQLiteColumnBuilder } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FieldDef, FieldType, LinkValue } from '../../../core/server/utils/defineCollection'
import { fieldIs } from '../../../core/server/utils/defineCollection'
import type { FieldTypeDescriptor } from './types'
import { sanitizeRichtext } from './sanitize'
import { choiceValues, numberIsInteger } from '../../app/utils/field-constraints'
import { slugify } from '../../../core/app/utils/slugify'
import { refineConditionalRequired } from '../utils/conditional-required'

// A conditional field is only `required` when its condition is met — which the per-column / per-field
// schema can't see (no sibling access). So it is never enforced HERE: the column stays nullable and the
// validator stays optional; the whole-record `applyConditions` hook re-enforces required-when-visible.
export function isHardRequired(field: FieldDef): boolean {
  return !!field.required && !field.condition
}

export function constrain<T extends SQLiteColumnBuilder>(col: T, field: FieldDef): T {
  let c = col
  if (isHardRequired(field)) c = c.notNull() as T
  if (field.unique) c = c.unique() as T
  if (field.default !== undefined) c = c.default(field.default as never) as T
  return c
}

export const opt = (s: z.ZodType, field: FieldDef): z.ZodType => (isHardRequired(field) ? s : s.nullish())
export const optArr = (s: z.ZodType, field?: FieldDef): z.ZodType =>
  field && isHardRequired(field)
    ? s.refine((v) => Array.isArray(v) && v.length > 0, { message: 'At least one value is required' })
    // Non-required: an EXPLICIT null is a clear → the empty array [] (so a PATCH `field: null` actually
    // resets it, consistent with the .nullish() scalar fields, rather than mapping to undefined which
    // drizzle's .set() silently skips). An absent (undefined) value stays undefined so the column default
    // ([]) applies on insert.
    : z.preprocess((v) => (v === null ? [] : v), s.optional())

// Array-backed column (multiple choice/media, many-relation, repeater). Honours a declared `default` (a
// default multi-selection / seed rows), serialized as a JSON literal by the schema renderer; else '[]'.
// (`unique` is intentionally not applied — a UNIQUE index over a JSON blob is not meaningful.)
const jsonArray = (dbName: string, field?: FieldDef) =>
  text(dbName, { mode: 'json' }).$type<unknown[]>().notNull()
    .default(field?.default !== undefined ? (field.default as never) : sql`'[]'`)

/** Type a built-in descriptor against its SPECIFIC arm (`FieldOf<T>`) so its body narrows correctly, then
 *  widen to the registry's general `FieldTypeDescriptor` for storage. */
const fieldType = <T extends FieldType>(d: FieldTypeDescriptor<T>): FieldTypeDescriptor =>
  d as unknown as FieldTypeDescriptor

/** Whether `field.unique` actually reaches a DB constraint for THIS field (options-dependent, not just
 *  type-dependent — a `choice`/`media` field is only json-backed when `multiple`, a `relation` only when
 *  `many`). Mirrors the `column()` arms above exactly: the json/array-backed arms (`jsonArray`, the plain
 *  `json` type) never call `constrain()`, so `.unique()` is never invoked — `unique: true` there is a silent
 *  no-op, not a soft hint. `buildTable` uses this to fail loud at collection-build time instead. */
export function fieldCanEnforceUnique(field: FieldDef): boolean {
  // `fieldIs` not `switch`: the open consumer arm makes `type` a non-discriminant (no switch narrowing).
  if (fieldIs(field, 'choice')) return !field.options.multiple
  if (fieldIs(field, 'media')) return !field.options?.multiple
  if (fieldIs(field, 'relation')) return !field.relation.many
  if (fieldIs(field, 'repeater')) return false
  if (fieldIs(field, 'json')) return false
  return true
}

export const fieldTypes: Record<string, FieldTypeDescriptor> = {
  text: fieldType<'text'>({
    column: (n, f) => constrain(text(n), f),
    // Plain text is stored verbatim (trimmed): the column is not HTML and every consumer
    // escapes on output, so tag-stripping here would only corrupt legitimate input (e.g. "a < b").
    validator: (f) => {
      let s = z.string().trim()
      if (f.type === 'text') {
        if (f.options?.minLength !== undefined) s = s.min(f.options.minLength)
        if (f.options?.maxLength !== undefined) s = s.max(f.options.maxLength)
      }
      // A hard-required string must be non-empty — '' / whitespace is "missing" to the client validator
      // and the conditional-required check, so the server (sole authority) must agree. Only add the
      // implicit min(1) when no explicit minLength already enforces a lower bound.
      if (isHardRequired(f) && (f.type !== 'text' || f.options?.minLength === undefined)) s = s.min(1)
      return opt(s, f)
    },
  }),
  // A url-safe slug, stored as text. Optionality-aware like text, but typically left non-required so it can
  // be omitted and auto-generated from another field. `transform` derives it on write: an explicit value is
  // slugified (normalised); a blank value falls back to slugify(record[options.from]) (e.g. the title). The
  // `options.from`/`options.prefix` are read by the client widget too (prefix is display-only). A `unique`
  // slug collision is a HARD, field-scoped error (`assertUniqueSlugs` in crud — no silent dedup; the editor
  // must pick a different slug), needing the DB the pure `transform` hook can't touch, so it lives in crud.
  slug: fieldType<'slug'>({
    column: (n, f) => constrain(text(n), f),
    validator: (f) => opt(isHardRequired(f) ? z.string().trim().min(1) : z.string().trim(), f),
    transform: (value, record, field) => {
      const explicit = typeof value === 'string' ? value.trim() : ''
      if (explicit) return slugify(explicit)
      const from = field.options?.from
      const source = from ? record[from] : undefined
      return typeof source === 'string' ? (slugify(source) || value) : value
    },
  }),
  richtext: {
    column: (n, f) => constrain(text(n), f),
    // Required richtext must carry content: sanitize first, then reject a sanitized-empty result
    // (e.g. '' or markup that strips to nothing), mirroring the non-empty rule for plain text.
    validator: (f) => {
      const base = z.string().transform(sanitizeRichtext)
      if (!isHardRequired(f)) return base.nullish()
      return base.refine((v) => v.trim().length > 0, { message: 'This field is required' })
    },
  },
  number: fieldType<'number'>({
    column: (n, f) =>
      constrain(!numberIsInteger(f.options) ? real(n) : integer(n), f),
    validator: (f) => {
      let n = z.number()
      if (numberIsInteger(f.options)) n = n.int()
      if (f.options?.min !== undefined) n = n.min(f.options.min)
      if (f.options?.max !== undefined) n = n.max(f.options.max)
      return opt(n, f)
    },
  }),
  boolean: {
    column: (n, f) => constrain(integer(n, { mode: 'boolean' }), f),
    validator: (f) => opt(z.boolean(), f),
  },
  datetime: fieldType<'datetime'>({
    column: (n, f) =>
      f.options?.range
        ? constrain(text(n, { mode: 'json' }).$type<{ start: string; end: string }>(), f)
        : constrain(text(n), f),
    validator: (f) => {
      const p = f.options?.precision ?? 'datetime'
      const base = p === 'date' ? z.iso.date() : p === 'time' ? z.iso.time() : z.iso.datetime({ local: true })
      if (f.options?.range) {
        const r = z.object({ start: base, end: base }).refine((v) => v.start <= v.end, { message: 'start must be before or equal to end' })
        return isHardRequired(f) ? r : r.nullish()
      }
      return opt(base, f)
    },
  }),
  choice: fieldType<'choice'>({
    column: (n, f) => (f.options.multiple ? jsonArray(n, f) : constrain(text(n), f)),
    validator: (f) => {
      const values = choiceValues(f.options)
      const e = z.enum(values)
      return f.options.multiple ? optArr(z.array(e), f) : opt(e, f)
    },
  }),
  link: {
    column: (n, f) => constrain(text(n, { mode: 'json' }).$type<LinkValue>(), f),
    // The validator is type-agnostic; options.types/collections only constrain the editor widget.
    validator: (f) => {
      const label = z.string().trim().optional()
      // Optional URL fragment for internal links (e.g. link to a page's section). Stored WITHOUT the
      // leading '#' (a lenient leading '#' is stripped); restricted to an id-safe charset since it ends
      // up verbatim in a static <a href>. `linkToHref` appends it as `<path>#<hash>` at render.
      const hash = z.string().trim().transform((s) => s.replace(/^#+/, '')).pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid anchor')).optional()
      return opt(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('internal'), collection: z.string().min(1), id: z.number().int(), hash, label }),
          z.object({
            type: z.literal('external'),
            // http(s) only, no control chars, no embedded credentials — the value ends up in a static <a href>.
            url: z.string().trim().pipe(z.url({ protocol: /^https?$/ })).refine((v) => {
              if (/[\u0000-\u001f]/.test(v)) return false
              const u = new URL(v)
              return !u.username && !u.password
            }, 'URL must not contain control characters or embedded credentials'),
            label,
          }),
          z.object({ type: z.literal('email'), email: z.string().trim().pipe(z.email()), label }),
          z.object({ type: z.literal('tel'), tel: z.string().trim().min(1).regex(/^[+0-9 ()\-.\/]+$/).refine((v) => /[0-9]/.test(v), 'Tel must contain at least one digit'), label }),
        ]),
        f,
      )
    },
  },
  media: fieldType<'media'>({
    column: (n, f) => (f.options?.multiple ? jsonArray(n, f) : constrain(integer(n), f)),
    validator: (f) =>
      f.options?.multiple ? optArr(z.array(z.number().int()), f) : opt(z.number().int(), f),
  }),
  relation: fieldType<'relation'>({
    column: (n, f) => (f.relation.many ? jsonArray(n, f) : constrain(integer(n), f)),
    validator: (f) =>
      f.relation.many ? optArr(z.array(z.number().int()), f) : opt(z.number().int(), f),
  }),
  repeater: fieldType<'repeater'>({
    column: (n, f) => jsonArray(n, f),
    validator: (f) => {
      const shape = Object.fromEntries(
        Object.entries(f.options.fields).map(([k, sub]) => [k, getFieldType(sub.type).validator(sub)]),
      )
      // Re-enforce conditional-required sub-fields per entry (the entry object is where siblings are visible).
      return optArr(z.array(refineConditionalRequired(z.object(shape), f.options.fields)), f)
    },
  }),
  json: {
    column: (n, f) => text(n, { mode: 'json' }).$type<unknown>().notNull().default(f?.default !== undefined ? (f.default as never) : sql`'{}'`),
    // Optionality-aware like every other arm. The column is NOT NULL with a '{}' default, so a non-required
    // null/undefined must become `undefined` (→ default applies) rather than reaching the column as null (an
    // unmapped NOT NULL 500); a required json must be present (a clean 400, not a 500).
    validator: (f) =>
      isHardRequired(f)
        ? z.unknown().refine((v) => v !== null && v !== undefined, { message: 'This field is required' })
        // Explicit null clears to {} (a PATCH reset); undefined stays absent so the column default ({}) applies.
        : z.preprocess((v) => (v === null ? {} : v), z.unknown().optional()),
  },
}

/** The names Kestrel ships built-in (captured before any consumer registration). */
const BUILTIN_FIELD_TYPES = new Set(Object.keys(fieldTypes))

/** Register a consumer-defined field type (via `defineFieldType`). Later registration wins, but never
 *  silently: a bad descriptor throws a clear error at registration (not a cryptic TypeError when a table is
 *  later built), and ANY re-registration of an existing name warns — overriding a built-in, or one extension
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
    console.warn(BUILTIN_FIELD_TYPES.has(name)
      ? `[kestrel] field type "${name}" overrides a built-in`
      : `[kestrel] field type "${name}" re-registered — the previous definition was overwritten`)
  }
  fieldTypes[name] = descriptor
}

/** Look up a field-type descriptor, with a clear error for an unknown / unregistered type. */
export function getFieldType(type: string): FieldTypeDescriptor {
  // Object.hasOwn guards the prototype chain: getFieldType('constructor') must throw the clear error, not
  // return Object.prototype.constructor and then crash with `.column is not a function` at table build.
  if (!Object.hasOwn(fieldTypes, type)) {
    throw new Error(`[kestrel] unknown field type "${type}" — register it with defineFieldType in server/field-types/`)
  }
  return fieldTypes[type]
}
