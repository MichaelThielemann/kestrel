import { eq, ne, lt, lte, gt, gte, sql, or, isNull, type SQL } from 'drizzle-orm'
import { createError } from 'h3'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { escapeLike } from './sql'
import type { FilterKind, FilterOp } from '../../app/utils/filter-ops'

/** Coerce a (stringified) filter value to the target COLUMN's storage type before the predicate. Keyed on
 *  the resolved Drizzle column (not the builtin def type-name) so a CUSTOM field type backed by a
 *  boolean/number column coerces too. parseFilter stringifies every query param, and drizzle maps any
 *  non-empty string (incl. 'false') to 1 for a boolean column, so an uncoerced boolean filter matches the
 *  wrong rows. (Owns this here — its single home — so both crud.list and filterCondition share it without a
 *  crud↔predicate import cycle.) */
export function coerceFilterValue(col: { getSQLType(): string; mode?: string }, value: unknown): unknown {
  if (col.mode === 'boolean') return value === true || value === 'true' || value === '1'
  // A timestamp column stores a Date and drizzle maps it via Date.getTime(); a raw string/number reaches
  // mapToDriverValue and throws `value.getTime is not a function` → an unhandled 500 (reachable
  // unauthenticated on any public collection). Coerce to a Date; an unparseable value is a clean 400.
  if (col.mode === 'timestamp' || col.mode === 'timestamp_ms') {
    const d = new Date(typeof value === 'number' ? value : String(value))
    if (Number.isNaN(d.getTime())) throw createError({ statusCode: 400, statusMessage: `Invalid timestamp filter value: ${String(value)}` })
    return d
  }
  const sqlType = col.getSQLType()
  if ((sqlType === 'integer' || sqlType === 'real') && typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  return value
}

/** JSON-array membership: EXISTS an element of the array column equal to the (typed) value. Fully
 *  parameterised — only the schema-derived column identifier is interpolated, never user input — matching
 *  media/usages.ts:25. A `stringSet` (multi choice) matches string members; an `idSet` (many relation/media)
 *  matches an integer id (a non-numeric filter value is a clean 400, not a mismatch that silently matches
 *  nothing). */
function member(col: AnySQLiteColumn, kind: 'stringSet' | 'idSet', raw: string): SQL {
  let value: string | number = raw
  if (kind === 'idSet') {
    // Number('') / Number('  ') are 0 (finite) and Number('1e3') is 1000 — none is a valid id token. Require a
    // plain (optionally signed) integer so a blank/garbage filter is a clean 400, not a silent empty match.
    const t = raw.trim()
    if (t === '' || !/^-?\d+$/.test(t)) throw createError({ statusCode: 400, statusMessage: `Invalid id filter value: ${raw}` })
    value = Number(t)
  }
  return sql`EXISTS (SELECT 1 FROM json_each(${sql.identifier(col.name)}) WHERE value = ${value})`
}

/**
 * The exclusive end of the DAY a date-only value names, or null when the rule does not apply. A datetime
 * column stores an instant, but `YYYY-MM-DD` (what a date picker and the `filter[c][op]=YYYY-MM-DD` wire
 * contract carry) names a whole day: compared against that day's midnight, "on or before" would drop the
 * day itself and "after" would return it. The next UTC day works for both storages — a `Date` for a
 * timestamp column, and a lexicographically correct string for a TEXT one ('2026-07-25T16:00' < '2026-07-26').
 */
function exclusiveDayEnd(kind: FilterKind, raw: string): string | null {
  if (kind !== 'datetime' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const d = new Date(`${raw}T00:00:00Z`)
  // A non-existent calendar date is left to the normal coercion rather than widened: '2026-13-01' is
  // unparseable (a clean 400 on a timestamp column) and '2026-02-31' rolls forward three days, so shifting
  // it would silently ask a different question than the URL states.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return null
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Build the WHERE predicate for ONE already-validated filter clause (the caller allow-lists `kind`/`op`).
 * Every user value crosses as a drizzle bound param; the only interpolation is `sql.identifier(col.name)`
 * (schema-derived, never user input) — injection-safe, matching picker.ts / usages.ts.
 *
 * The json_each membership and LIKE ESCAPE are SQLite-specific but consistent with the existing query code
 * and the SQLite-only engine; a future Postgres query dialect would have to supply @>/ILIKE variants here
 * (a loud compile failure, never a silent mis-query). NOTE: `contains` on text/richtext matches the STORED
 * string — for richtext that is the HTML source, so 'p' can hit a '<p>' tag (documented caveat; a stripped
 * shadow column / FTS index is a later enhancement).
 */
export function filterCondition(col: AnySQLiteColumn, kind: FilterKind, op: FilterOp, raw: string): SQL {
  switch (op) {
    case 'eq': return eq(col, coerceFilterValue(col, raw))
    // SQL <> excludes NULL by three-valued logic; "is not X" must still surface an uncategorised (NULL) row.
    case 'ne': { const v = coerceFilterValue(col, raw); return col.notNull ? ne(col, v) : or(ne(col, v), isNull(col))! }
    case 'lt': return lt(col, coerceFilterValue(col, raw))
    // Only the two bounds that would fall on the wrong side of a whole day get the boundary swap; `lt` /
    // `gte` already mean "before the day" / "from the day on" when compared against its midnight.
    case 'lte': {
      const end = exclusiveDayEnd(kind, raw)
      return end ? lt(col, coerceFilterValue(col, end)) : lte(col, coerceFilterValue(col, raw))
    }
    case 'gt': {
      const end = exclusiveDayEnd(kind, raw)
      return end ? gte(col, coerceFilterValue(col, end)) : gt(col, coerceFilterValue(col, raw))
    }
    case 'gte': return gte(col, coerceFilterValue(col, raw))
    case 'contains':
      if (kind === 'stringSet' || kind === 'idSet') return member(col, kind, raw)
      // text / richtext substring (SQLite LIKE is ASCII case-insensitive); LIKE metacharacters escaped.
      return sql`${col} like ${`%${escapeLike(raw)}%`} escape '\\'`
    case 'notContains':
      return sql`NOT ${member(col, kind as 'stringSet' | 'idSet', raw)}`
  }
}
