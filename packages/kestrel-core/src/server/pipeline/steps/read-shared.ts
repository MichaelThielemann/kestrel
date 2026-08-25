import type { FilterOp } from '../../../app/utils/filter-ops.js'
import type { PipelineContext } from '../types.js'

/** Read-scope: published rows only unless the access gate resolved full scope. A programmatic caller may
 *  pin the flag through `work` (the CRUD facade does, from its own parameter); an HTTP run leaves it unset
 * @public
 *  and inherits the gate's answer. Fail-closed on both planes — only an explicit `'all'` sees drafts. */
export function publishedOnlyOf(ctx: PipelineContext): boolean {
  return ctx.work.publishedOnly === undefined ? ctx.facts.readScope !== 'all' : Boolean(ctx.work.publishedOnly)
}

/** Populate-scope: keyed on the ROLE, not the read scope — the renderer reads published-only too but must
 * @public
 *  still see every relation the static output embeds. Fail-closed on a missing principal. */
export function publicOnlyOf(ctx: PipelineContext): boolean {
  return ctx.work.publicOnly === undefined
    ? (ctx.facts.principal?.role ?? 'anonymous') === 'anonymous'
    : Boolean(ctx.work.publicOnly)
}

// Upper bound on relation/media populate recursion. `depth` is attacker-controlled on anonymous reads
// (both list + detail routes accept `?depth`), and the relation populator recurses one getOne per level —
// an unbounded value drives thousands of synchronous DB reads / a stack overflow. No real content nests
// beyond a handful of hops, so clamp hard.
const MAX_DEPTH = 10
/** @public */
export const clampDepth = (value: unknown): number => Math.min(MAX_DEPTH, Math.max(0, Number(value) || 0))

/** One parsed filter clause. The wire stays a FilterClause[] (not a `Record<field,value>`) so a repeated
 *  key AND-s (two `contains` on one array field) and a range clause-builder can layer on later without a
 * @public
 *  re-migration. */
export interface FilterClause {
  field: string
  op: FilterOp
  value: string
}

/** @public */
export interface ListQuery {
  locale?: string | string[]
  sort?: string | string[]
  page?: number
  perPage?: number
  filter?: FilterClause[]
  depth?: number
  /** Skip the total count() query (default: compute it). Set false on the prerender/resolvePage hot
   *  path, which reads only the first row and discards `total` — saving a count() per page-like probe. */
  withTotal?: boolean
  /** Skip the publish dependency capture (default: capture a collection-level tag). Set false for the
   *  resolvePage self-lookup, which captures the found record instead of the whole collection. */
  capture?: boolean
}

/** @public */
export interface ListResult {
  data: Record<string, unknown>[]
  total: number
  page: number
  perPage: number
  /** Set by `validateOut` — count of rows in `data` replaced with the quarantine shape. */
  quarantinedCount?: number
}
