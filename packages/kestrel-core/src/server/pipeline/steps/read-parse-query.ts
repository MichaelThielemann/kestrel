import { asc, desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { ValidationFailed } from '@kestrel/contracts'
import type { SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { captureRead, resolveColumnName } from '@kestrel/core'
import type { BuiltCollection } from '@kestrel/core'
import { primaryLocale, resolveLocale } from '../../utils/locale.js'
import { filterCondition } from '../../utils/filter-predicate.js'
import { serializeField } from '../../utils/serialize-collection.js'
import { fieldFilterKind, opAllowed, type FilterKind } from '../../../app/utils/filter-ops.js'
import { clampPerPage } from '../../../app/utils/list-limits.js'
import { collectionOf, columns } from './shared.js'
import { clampDepth, type ListQuery } from './read-shared.js'
import { syncStep, type StepDef } from '../types.js'

/** The allow-list of a collection's filterable columns → their FilterKind (drives op validation + predicate
 *  building). Built per-request from the schema; a column absent here can't be filtered (a clean 400). */
function filterKindMap(c: BuiltCollection): Record<string, FilterKind> {
  const map: Record<string, FilterKind> = { id: 'number' }
  for (const [key, f] of Object.entries(c.def.fields)) {
    const kind = fieldFilterKind(serializeField(f))
    if (kind) map[resolveColumnName(key, f).jsKey] = kind
  }
  if (c.def.pageLike) map.path = 'text'
  if (c.def.status) map.status = 'enum'
  map.createdAt = 'datetime'
  map.updatedAt = 'datetime'
  return map
}

/** What `fetch` needs to run the select — conditions here never include the `publishedOnly` scope, which
 * @public
 *  `fetch` (sealed) applies itself. */
export interface ParsedListQuery {
  conds: SQL[]
  cols: Record<string, AnySQLiteColumn>
  orderColumn: AnySQLiteColumn
  direction: typeof asc
  page: number
  perPage: number
  depth: number
  populateLocale: string
}

/** @public */
export function parseQueryStep(): StepDef {
  return syncStep('parseQuery', (ctx) => Effect.gen(function* () {
      const c = collectionOf(ctx)
      const q = ctx.input as ListQuery
      // A listing depends on the whole collection (any add/remove/edit changes it) — tag it collection-level.
      if (q.capture !== false) captureRead(c.def.name)
      const cols = columns(c)
      const conds: SQL[] = []

      const localeRaw = Array.isArray(q.locale) ? q.locale[0] : q.locale
      const sortRaw = Array.isArray(q.sort) ? q.sort[0] : q.sort

      // One normalized locale drives BOTH the WHERE filter and the populate locale. `all` means
      // "no locale filter"; there is no single populate locale then, so fall back to primary.
      let populateLocale = primaryLocale()
      if (c.def.translatable && localeRaw !== 'all') {
        const loc = resolveLocale(localeRaw)
        conds.push(eq(cols.locale, loc))
        populateLocale = loc
      }

      const kinds = filterKindMap(c)
      for (const cl of q.filter ?? []) {
        // Object.hasOwn on both maps is prototype-safe: a `toString`/`__proto__` field never resolves to an
        // inherited member — it is an unknown (unfilterable) field → a clean 400.
        if (!Object.hasOwn(kinds, cl.field) || !Object.hasOwn(cols, cl.field)) {
          return yield* Effect.fail(new ValidationFailed({ issues: [{ path: [cl.field], message: `Unknown filter field: ${cl.field}` }] }))
        }
        const kind = kinds[cl.field]!
        if (!opAllowed(kind, cl.op)) {
          return yield* Effect.fail(new ValidationFailed({ issues: [{ path: [cl.field], message: `Operator "${cl.op}" is not allowed for field "${cl.field}"` }] }))
        }
        conds.push(filterCondition(cols[cl.field]!, kind, cl.op, cl.value))
      }

      let orderColumn = cols.createdAt
      let direction: typeof asc = desc
      if (sortRaw) {
        const descending = sortRaw.startsWith('-')
        const name = descending ? sortRaw.slice(1) : sortRaw
        if (!Object.hasOwn(cols, name)) return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['sort'], message: `Unknown sort field: ${name}` }] }))
        orderColumn = cols[name]
        direction = descending ? desc : asc
      }

      // `?? default` only catches null/undefined, NOT NaN (e.g. `?page=abc` → Number('abc') === NaN), which
      // would then bind `.offset(NaN)` = OFFSET NULL — a garbage query. Guard `page` with Number.isFinite;
      // `perPage` is clamped by the shared `clampPerPage` (which also blocks the `.limit(NaN)` cap-bypass).
      const num = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback)
      const page = Math.max(1, Math.floor(num(q.page, 1)))
      const perPage = clampPerPage(q.perPage)
      const depth = clampDepth(q.depth)

      ctx.work.parsedQuery = { conds, cols, orderColumn, direction, page, perPage, depth, populateLocale } satisfies ParsedListQuery
  }))
}
