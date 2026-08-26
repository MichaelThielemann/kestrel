import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { BuiltCollection, CollectionDef } from '@michaelthielemann/kestrel-core'
import { nextSlugCandidate, normalizeSlugPath } from '../pipeline/core/slug.js'
import { routeOf, findRouteConflict } from './page-route.js'

/**
 * The KEY of the text field Kestrel derives an auto-slug from: the `title` field if present, else the
 * first text field (or `undefined` when the collection has no text field). Text fields keep their key as
 * their column key (no `Id` suffix), so both the record value and a write target read directly by this key
 * — which keeps this in `core` without importing the `fields` naming layer. Exported so the duplicate
 * operation appends its `(copy)` suffix to the SAME field the slug derives from.
 * @public
 */
export function slugSourceKey(def: CollectionDef): string | undefined {
  const fields = Object.entries(def.fields)
  const pick = fields.find(([k, f]) => k === 'title' && f.type === 'text') ?? fields.find(([, f]) => f.type === 'text')
  return pick?.[0]
}

/** The trimmed string value of that slug-source field on a record (empty when absent / non-string).
 * @public
 */
export function slugSourceValue(def: CollectionDef, record: Record<string, unknown>): string {
  const key = slugSourceKey(def)
  if (!key) return ''
  const v = record[key]
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The ONE `-N` de-dup loop: probe `hasConflict` for `base`, then `base-2`, `base-3`, … (via the core's
 * `nextSlugCandidate`) until a free candidate is found or 1000 candidates have been tried. Shared by the
 * write pipeline's `resolveSlug` step (auto-generated slugs) and the duplicate op (`dedupeSourcePath`) so
 * there is a single route-uniqueness implementation, not two forks of the same `-N` logic.
 * @public
 */
export function dedupeAgainstConflicts(base: string, hasConflict: (candidate: string) => boolean): string {
  let n = 1
  let candidate = nextSlugCandidate(base, n)
  while (n < 1000 && hasConflict(candidate)) {
    candidate = nextSlugCandidate(base, ++n)
  }
  return candidate
}

/**
 * The free route a pageLike COPY should claim when its collection has NO slug-source text field for the
 * auto-gen branch to derive from: the SOURCE row's own explicit `path`, de-duped (`-2`, `-3`, …) to the
 * first free global route via `dedupeAgainstConflicts`. Seeding this (instead of leaving `path` blank →
 * a 400, or re-using the source's colliding path → a 409) lets `create()`'s explicit branch accept it.
 * Returns null when the source has no usable path (the caller lets create()'s own 400 surface).
 * @public
 */
export function dedupeSourcePath(
  db: BetterSQLite3Database,
  c: BuiltCollection,
  sourceRow: Record<string, unknown>,
  ctx: { collections: BuiltCollection[], primary: string, prefixPrimary: boolean },
): string | null {
  const raw = sourceRow.path
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const translatable = !!c.def.translatable
  const locale = translatable && typeof sourceRow.locale === 'string' && sourceRow.locale ? sourceRow.locale : ctx.primary
  const routeFor = (p: string) => routeOf({ path: p, locale }, translatable, ctx.primary, ctx.prefixPrimary)!
  const exclude = { collection: c.name, id: null }
  return dedupeAgainstConflicts(
    normalizeSlugPath(raw),
    (candidate) => !!findRouteConflict(db, routeFor(candidate), ctx.primary, ctx.collections, exclude, ctx.prefixPrimary),
  )
}
