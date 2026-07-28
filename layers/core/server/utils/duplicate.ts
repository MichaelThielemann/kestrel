import { eq, getTableColumns } from 'drizzle-orm'
import { createError } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BuiltCollection } from './collection-types'
import { create } from './crud'
import { slugSourceKey, dedupeSourcePath } from './page-slug'
import { primaryLocale, prefixPrimaryLocale } from './locale'
import { allCollections } from './registry'
import { fieldIs, type FieldOf } from './defineCollection'
import { slugify } from '../../app/utils/slugify'
import { resolveColumnName } from '../../../fields/server/field-registry/naming'
import { isHardRequired } from '../../../fields/server/field-registry/index'
import { regenerateBlockIds } from '../../../fields/server/utils/block-ids'

type DB = BetterSQLite3Database
type Row = Record<string, unknown>

/**
 * Append (or increment) a plain `(copy)` suffix on a title-like string:
 *   `Foo` → `Foo (copy)` → `Foo (copy 2)` → `Foo (copy 3)` → …
 * Pure and non-localized; drives BOTH the list label and (for pageLike / slug fields) the derived slug.
 * When `maxLength` is given (the slug-source field's `options.maxLength`), the BASE is truncated so the
 * whole `base + suffix` result still fits — so a record at (or within a suffix of) its length limit stays
 * duplicable instead of tripping create()'s re-validated `.max`. When the maxLength cannot fit even the
 * suffix on its own, the source text is returned unchanged (no suffix); for a pageLike copy the `-N` route
 * de-dup then still guarantees a unique slug. The increment rule holds under truncation.
 */
export function withCopySuffix(text: string, maxLength?: number): string {
  const m = /^(.*) \(copy(?: (\d+))?\)$/.exec(text)
  const base = m ? m[1]! : text
  const n = (m ? (m[2] ? Number.parseInt(m[2], 10) : 1) : 0) + 1
  const suffix = n === 1 ? '(copy)' : `(copy ${n})`
  const full = base ? `${base} ${suffix}` : suffix
  if (maxLength === undefined || full.length <= maxLength) return full
  // The suffix alone overflows the budget → drop it (a pageLike copy's `-N` route de-dup still disambiguates).
  if (suffix.length > maxLength) return text.slice(0, maxLength)
  // Truncate the base so `base + ' ' + suffix` fits exactly within maxLength (−1 for the joining space).
  const room = maxLength - suffix.length - 1
  const truncated = room > 0 ? base.slice(0, room).trimEnd() : ''
  return truncated ? `${truncated} ${suffix}` : suffix
}

/** The one field whose verbatim copy CANNOT be reconciled: required + unique + not a slug (a slug re-derives,
 *  the pageLike path re-derives+de-dupes). Returns its def key, or `undefined` when the collection has none. */
function blockingUniqueField(c: BuiltCollection): string | undefined {
  for (const [key, f] of Object.entries(c.def.fields)) {
    if (f.unique && isHardRequired(f) && f.type !== 'slug') return key
  }
  return undefined
}

/**
 * Duplicate one record into a NEW draft copy, composing `crud.create()` so validation, the fresh
 * translationGroup nanoid, the slug de-dup, field transforms, the unique-slug check, the insert AND
 * `emitWrite` (which rebuilds `record_refs` and drives the publish queue) all come for free — there is NO
 * parallel insert path. The copy:
 *   • strips id / timestamps → a fresh PK + timestamps (create() also strips them);
 *   • drops `translationGroup` → create() mints a new group, so the copy is a LONE row in a brand-new group
 *     for its single locale (Option A — keeping the group would violate the UNIQUE(group, locale) index);
 *   • blanks `path` (pageLike) → `resolvePageSlug` re-derives + `-2`/`-3` de-dupes from the suffixed title,
 *     or — for a pageLike collection with NO slug-source text field — seeds the source's path, de-duped;
 *   • forces `status: 'draft'` → a copy of a published record is NOT itself published;
 *   • regenerates every block id → the copy never shares block identity with its source;
 *   • appends a `(copy)` suffix to the slug-source text field → the label and derived slug read "Foo (copy)";
 *   • blanks non-required unique fields EXCEPT the slug-source (its `(copy)` suffix already makes it distinct);
 *   • SHARES referenced media / relations / links verbatim (scalar column values copied, never deep-copied).
 * Throws: 405 for a singleton · 404 for an unknown id · 422 (naming the field) when a REQUIRED UNIQUE field
 * that is not the slug/path would collide verbatim (surfaced up-front instead of a raw SQLite 409).
 */
export function duplicateRecord(db: DB, c: BuiltCollection, id: number): Row {
  if (c.def.mode === 'single') {
    throw createError({ statusCode: 405, statusMessage: 'Cannot duplicate a singleton' })
  }
  const blocking = blockingUniqueField(c)
  if (blocking) {
    throw createError({ statusCode: 422, statusMessage: `Cannot duplicate: the required unique field "${blocking}" would collide` })
  }

  const cols = getTableColumns(c.table) as Record<string, AnySQLiteColumn>
  // RAW row (NOT getOne — no populate): populate nests media/relations into objects that would not round-
  // trip through the insert schema; the duplicate must copy the stored scalar FKs so the copy SHARES them.
  const src = db.select().from(c.table as AnySQLiteTable).where(eq(cols.id, id)).get() as Row | undefined
  if (!src) throw createError({ statusCode: 404, statusMessage: `${c.name} ${id} not found` })

  const body: Row = { ...src }
  delete body.id
  delete body.createdAt
  delete body.updatedAt
  delete body.translationGroup
  delete body.path
  if (c.def.status) body.status = 'draft'
  if (c.def.blocks?.enabled) body.content = regenerateBlockIds(src.content)

  appendCopySuffix(c, body)
  blankNonRequiredUniqueFields(db, c, body)
  seedCopyPath(db, c, src, body)

  return create(db, c, body)
}

/** Suffix the slug-source text field (the same field `slugSourceValue`/`resolvePageSlug` derive from),
 *  budgeting the suffix against the field's `options.maxLength` so a record at its length limit stays
 *  duplicable (create() re-validates the text `.max`). */
function appendCopySuffix(c: BuiltCollection, body: Row): void {
  const key = slugSourceKey(c.def)
  if (!key) return
  const value = body[key]
  if (typeof value !== 'string') return
  const field = c.def.fields[key]
  const maxLength = field && fieldIs(field, 'text') ? field.options?.maxLength : undefined
  body[key] = withCopySuffix(value, maxLength)
}

/** A unique field can't be copied verbatim (it would collide). A unique `slug` is re-derived from the
 *  now-suffixed source AND de-duped with a `-N` suffix against existing rows (so duplicating the SAME
 *  record twice yields `foo-copy`, then `foo-copy-2` — a plain slug field has no pageLike `-N` path dedup
 *  of its own, so two copies would otherwise collide on create's hard unique-slug check). Any OTHER unique
 *  field (guaranteed non-hard-required by the pre-flight — its column is nullable) falls to NULL, which
 *  SQLite permits many of. The slug-SOURCE text field is EXEMPT even when itself `unique`: its `(copy)`
 *  suffix already distinguishes it, so nulling it would be silent data loss (and, for a pageLike
 *  collection, leave resolvePageSlug no title → a 400). */
function blankNonRequiredUniqueFields(db: DB, c: BuiltCollection, body: Row): void {
  const slugSource = slugSourceKey(c.def)
  const cols = getTableColumns(c.table) as Record<string, AnySQLiteColumn>
  for (const [key, f] of Object.entries(c.def.fields)) {
    if (!f.unique || key === slugSource) continue
    const { jsKey } = resolveColumnName(key, f)
    if (fieldIs(f, 'slug')) body[jsKey] = dedupedCopySlug(db, c, cols, key, f, body)
    else body[jsKey] = null
  }
}

/** The de-duped slug for a copy: slugify the (already `(copy)`-suffixed) `from` source, else the copied
 *  slug value, then append `-2`/`-3`/… until it is free. Empty base → undefined (let create's transform try). */
function dedupedCopySlug(db: DB, c: BuiltCollection, cols: Record<string, AnySQLiteColumn>, key: string, f: FieldOf<'slug'>, body: Row): string | undefined {
  const { jsKey } = resolveColumnName(key, f)
  const from = f.options?.from
  const source = from ? body[from] : undefined
  const base = typeof source === 'string' && source ? slugify(source)
    : typeof body[jsKey] === 'string' ? slugify(body[jsKey] as string) : ''
  if (!base) return undefined
  let candidate = base
  for (let n = 2; db.select({ id: cols.id }).from(c.table as AnySQLiteTable).where(eq(cols[jsKey]!, candidate)).get(); n++) {
    candidate = `${base}-${n}`
  }
  return candidate
}

/** For a pageLike collection with NO slug-source text field, create()'s auto-gen branch has no title to
 *  derive a slug from (and duplicate blanked `path`), so seed the copy's `path` off the SOURCE row's own
 *  explicit path — de-duped to a free route — which create()'s explicit branch then accepts. A no-op for
 *  every other collection (the suffixed title drives the slug) and when the source carries no usable path. */
function seedCopyPath(db: DB, c: BuiltCollection, src: Row, body: Row): void {
  if (!c.def.pageLike || slugSourceKey(c.def)) return
  const path = dedupeSourcePath(db, c, src, {
    collections: allCollections(),
    primary: primaryLocale(),
    prefixPrimary: prefixPrimaryLocale(),
  })
  if (path) body.path = path
}
