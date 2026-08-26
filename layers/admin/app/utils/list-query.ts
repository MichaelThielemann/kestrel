import { FILTER_RE, clampPerPage, isFilterOp, opAllowed } from '@michaelthielemann/kestrel-core/client'
import type { FilterOp } from '@michaelthielemann/kestrel-core/client'
import type { ListColumn } from './list-columns'

// The page-size bounds live in ONE shared module (core/app/utils/list-limits) so the client list, the
// per-page picker and the server crud cap can never drift; `toQuery` clamps through it below.

/** One active filter clause in the admin UI: the chosen operator + its (string) value. Kept per-column
 *  (`Record<field, FilterCell>`) — the per-column panel shows one clause per column. */
export interface FilterCell {
  op: FilterOp
  value: string
}

export interface ListState {
  sort: string | null
  page: number
  perPage: number
  filter: Record<string, FilterCell>
}

/** UI state -> the `$fetch` query object the list endpoint expects. An `eq` clause stays the bare
 *  `filter[field]` key (so existing URLs round-trip); any other operator serializes as `filter[field][op]`.
 *  Empty-valued clauses are dropped. `perPage` is clamped. */
export function toQuery(state: ListState): Record<string, string | number> {
  const q: Record<string, string | number> = {
    page: Math.max(1, Math.floor(state.page)),
    perPage: clampPerPage(state.perPage),
  }
  if (state.sort) q.sort = state.sort
  for (const [field, cell] of Object.entries(state.filter)) {
    if (cell.value === '' || cell.value == null) continue
    q[cell.op === 'eq' ? `filter[${field}]` : `filter[${field}][${cell.op}]`] = cell.value
  }
  return q
}

/** Pick the first usable scalar from a URL query value. Real `route.query` values are strings (or arrays of
 *  strings for a repeated key — we take the first, so `filter[x]=a&filter[x]=b` keeps the FIRST clause); a
 *  round-trip through `toQuery` may hand back a number (page/perPage), so coerce that too. Anything else
 *  (null / object) yields `undefined`. */
function firstStr(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v
  if (typeof s === 'string') return s
  if (typeof s === 'number') return String(s)
  return undefined
}

/** The pure inverse of `toQuery`: read committed list state back OUT of a URL query. It NEVER throws — every
 *  invalid or hostile key is DROPPED so the caller's defaults apply (a junk `page`/`perPage`, an unknown or
 *  non-sortable `sort` field, an unknown/unfilterable filter column, or an operator not allowed for that
 *  column's kind). A repeated `filter[field]` keeps the FIRST clause (the admin model holds one clause per
 *  column). Absent/invalid keys are OMITTED, so `parseListQuery(toQuery(state), columns)` deep-equals the
 *  normalized `state`. */
export function parseListQuery(query: Record<string, unknown>, columns: ListColumn[]): Partial<ListState> {
  const out: Partial<ListState> = {}

  const p = firstStr(query.page)
  if (p != null) { const n = Number(p); if (Number.isFinite(n) && n >= 1) out.page = Math.floor(n) }

  const pp = firstStr(query.perPage)
  if (pp) { const n = Number(pp); if (Number.isFinite(n)) out.perPage = clampPerPage(n) } // garbage → omit → cookie

  const s = firstStr(query.sort)
  if (s) { const base = s.startsWith('-') ? s.slice(1) : s; if (columns.some((c) => c.key === base && c.sortable)) out.sort = s } // unknown/non-sortable → omit → default

  const filter: Record<string, FilterCell> = {}
  for (const [k, raw] of Object.entries(query)) {
    const m = FILTER_RE.exec(k)
    if (!m) continue
    const field = m[1]!
    if (field in filter) continue // one clause per column: the first key for this field wins
    const op = m[2] ?? 'eq'
    const value = firstStr(raw)
    if (value == null || value === '') continue // empty value → drop
    if (!isFilterOp(op)) continue // unknown operator token → drop
    const col = columns.find((c) => c.key === field && c.filterable)
    if (!col) continue // unknown / unfilterable column → drop
    if (!opAllowed(col.filterKind ?? 'text', op)) continue // op disallowed for the column kind → drop
    filter[field] = { op, value }
  }
  if (Object.keys(filter).length) out.filter = filter

  return out
}

/** Toggle a column between ascending (`field`) and descending (`-field`); a new field starts ascending. */
export function toggleSort(current: string | null, field: string): string {
  return current === field ? `-${field}` : field
}

export function sortDirection(current: string | null, field: string): 'asc' | 'desc' | null {
  if (current === field) return 'asc'
  if (current === `-${field}`) return 'desc'
  return null
}
