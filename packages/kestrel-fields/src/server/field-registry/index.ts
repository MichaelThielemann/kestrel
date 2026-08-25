import { integer, real, text } from 'drizzle-orm/sqlite-core'
import type { SQLiteColumnBuilder } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { fieldCanEnforceUnique, getFieldType, isHardRequired, refineConditionalRequired, registerFieldType, seedBuiltinFieldTypes, slugify, sanitizeRichtext } from '@kestrel/core'
import type { FieldDef, FieldType, FieldTypeDescriptor, LinkValue } from '@kestrel/core'
import { choiceValues, numberIsInteger } from '../../app/utils/field-constraints.js'
export { isHardRequired, fieldCanEnforceUnique, registerFieldType, getFieldType, type FieldTypeDescriptor }

/** Applies a scalar field's shared column constraints (`notNull`, `unique`, `default`) to a Drizzle column
 *  builder, in the field-type arms that back a single, non-array column.
 * @public
 */
export function constrain<T extends SQLiteColumnBuilder>(col: T, field: FieldDef): T {
  let c = col
  if (isHardRequired(field)) c = c.notNull() as T
  if (field.unique) c = c.unique() as T
  if (field.default !== undefined) c = c.default(field.default as never) as T
  return c
}

/** Wraps a scalar Zod schema `s` as `.nullish()` unless `field` is hard-required. The optionality
 *  counterpart to `constrain`'s `notNull`.
 * @public
 */
export const opt = (s: z.ZodType, field: FieldDef): z.ZodType => (isHardRequired(field) ? s : s.nullish())

/** The array-field counterpart to `opt`: a hard-required array must be non-empty; otherwise an explicit
 *  `null` clears to `[]` (so a PATCH `field: null` actually resets it, consistent with `.nullish()` scalar
 *  fields) while an absent value stays `undefined` so the column default (`[]`) applies on insert.
 * @public
 */
export const optArr = (s: z.ZodType, field?: FieldDef): z.ZodType =>
  field && isHardRequired(field)
    ? s.refine((v) => Array.isArray(v) && v.length > 0, { message: 'At least one value is required' })
    // Mapping null to [] rather than undefined matters: drizzle's .set() silently skips undefined.
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

/** The built-in field types Kestrel ships, keyed by name — seeded into the core registry below. Extended
 *  in place by consumer `registerFieldType` calls after seeding; `getFieldType` is the read side, re-
 *  exported above. */
const builtinFieldTypes: Record<string, FieldTypeDescriptor> = {
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
              // eslint-disable-next-line no-control-regex -- deliberately rejects control characters embedded in a URL destined for a static <a href>
              if (/[\u0000-\u001f]/.test(v)) return false
              const u = new URL(v)
              return !u.username && !u.password
            }, 'URL must not contain control characters or embedded credentials'),
            label,
          }),
          z.object({ type: z.literal('email'), email: z.string().trim().pipe(z.email()), label }),
          z.object({ type: z.literal('tel'), tel: z.string().trim().min(1).regex(/^[+0-9 ()\-./]+$/).refine((v) => /[0-9]/.test(v), 'Tel must contain at least one digit'), label }),
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

/** Seeds the core registry with Kestrel's built-in field types. Must run before any consumer
 *  `registerFieldType` call (module load order — this file is imported by `defineFieldType.ts`, which
 *  every consumer field-type file imports).
 *
 *  Bound to the CALL's return value, not re-exported straight from core untouched: a bundler can prove a
 *  pure re-export of core's already-declared (empty) `fieldTypes` doesn't need this call and tree-shake
 *  the whole built-in set away (seen in Nitro's dev build) — it cannot prove that about a value only this
 *  call can produce.
 * @public
 */
export const fieldTypes = seedBuiltinFieldTypes(builtinFieldTypes)
