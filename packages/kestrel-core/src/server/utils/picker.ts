import { and, count, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { MAX_BULK_IDS } from '../../app/utils/list-limits.js'
import { escapeLike } from '@michaelthielemann/kestrel-core'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'
import { resolveLocale } from './locale.js'
type DB = BetterSQLite3Database

/** @public */
export interface PickerQuery {
  search?: string
  ids?: number[]
  label?: string
  page?: number
  perPage?: number
  locale?: string
  /** Published-scope read (anonymous / SSG): hide draft rows + labels, like list()/getOne(). */
  publishedOnly?: boolean
}

/** @public */
export interface PickerResult {
  data: { id: number; label: string }[]
  total: number
  page: number
  perPage: number
}

/** The field key used as the human label: an explicit text field, else the first text field, else 'id'. */
function resolveLabelKey(c: BuiltCollection, requested?: string): string {
  const fields = c.def.fields
  if (requested && fields[requested]?.type === 'text') return requested
  for (const [key, field] of Object.entries(fields)) if (field.type === 'text') return key
  return 'id'
}

/** @public */
export function pickerOptions(db: DB, c: BuiltCollection, q: PickerQuery): PickerResult {
  const cols = getTableColumns(c.table) as Record<string, never>
  const t = c.table as AnySQLiteTable
  const labelKey = resolveLabelKey(c, q.label)
  const labelCol = cols[labelKey] ?? cols.id

  // Validate the locale (consistent 400) up front; only apply it as a filter in search/list mode.
  const localeCond = c.def.translatable ? eq(cols.locale, resolveLocale(q.locale)) : undefined

  // A blank label must fall back too (not just nullish): the editor's combobox mirrors this label into
  // its input text, and an empty label would leave a validly selected record looking unselected.
  const toOption = (r: Record<string, unknown>) => {
    const label = String(r[labelKey] ?? '').trim()
    return { id: Number(r.id), label: label || `#${r.id}` }
  }

  // Published-scope read hides drafts (like list()/getOne()), so a picker on a public surface never leaks
  // draft titles. Only applies when the collection has a status column.
  const statusCond = q.publishedOnly && Object.hasOwn(cols, 'status') ? eq(cols.status, 'published') : undefined

  // ids mode: resolve the picker's current value(s) to labels. A present-but-empty ids list
  // (e.g. all non-numeric) is an explicit empty result, not a full list. The id is a globally
  // unique PK (each locale is its own row), so the locale predicate is intentionally NOT applied
  // here — it could only drop an already-valid selection across locales.
  if (q.ids) {
    if (!q.ids.length) return { data: [], total: 0, page: 1, perPage: 0 }
    const rows = db.select().from(t).where(and(inArray(cols.id, q.ids.slice(0, MAX_BULK_IDS)), statusCond)).limit(MAX_BULK_IDS).all() as Record<string, unknown>[]
    return { data: rows.map(toOption), total: rows.length, page: 1, perPage: rows.length }
  }

  // search / list mode.
  const conds = []
  if (localeCond) conds.push(localeCond)
  if (statusCond) conds.push(statusCond)
  if (q.search && labelKey !== 'id') conds.push(sql`${labelCol} like ${`%${escapeLike(q.search)}%`} escape '\\'`)
  const where = conds.length ? and(...conds) : undefined

  const num = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback)
  const page = Math.max(1, Math.floor(num(q.page, 1)))
  const perPage = Math.min(100, Math.max(1, Math.floor(num(q.perPage, 25))))

  const rows = db.select().from(t).where(where)
    .orderBy(labelCol).limit(perPage).offset((page - 1) * perPage).all() as Record<string, unknown>[]
  const totalRow = db.select({ value: count() }).from(t).where(where).get() as { value: number } | undefined
  return { data: rows.map(toOption), total: Number(totalRow?.value ?? 0), page, perPage }
}
