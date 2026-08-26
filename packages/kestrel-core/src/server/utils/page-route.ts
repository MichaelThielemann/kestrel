import { getTableColumns } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'
import { localePath } from '../../app/utils/locale-path.js'

/**
 * THE single definition of "stored page-like row → public output route":
 * `localePath(path, the row's OWN locale, …)`, or null when the row is missing or has no path. Every route-deriving site delegates
 * here — slug-uniqueness (`routeOf`/`findRouteConflict`), internal-link targets (`link-resolve`), the
 * publish-status endpoint (`routeForRecord`), and the publisher + its invalidation — so the URL scheme
 * lives in one place. A non-translatable row simply carries no `locale`, so it falls back to `primary`.
 * @public
 */
export function pageRowHref(row: { path?: unknown; locale?: unknown } | null | undefined, primary: string, prefixPrimary = false): string | null {
  if (!row || typeof row.path !== 'string' || !row.path) return null
  const locale = typeof row.locale === 'string' && row.locale ? row.locale : primary
  return localePath(row.path, locale, primary, prefixPrimary)
}

/**
 * Route for a pageLike row honoring a collection's `translatable` flag: a translatable collection
 * localizes by the row's `locale`, a non-translatable one is always primary-locale (ignores any stray
 * `locale`). Thin wrapper over `pageRowHref`, used by the slug-uniqueness scan.
 * @public
 */
export function routeOf(row: { path?: unknown; locale?: unknown }, translatable: boolean, primary: string, prefixPrimary = false): string | null {
  return pageRowHref(translatable ? row : { path: row.path }, primary, prefixPrimary)
}

/** @public */
export interface RouteConflict { collection: string; id: number }

/**
 * The first pageLike record — across ALL given collections — whose resolved route equals `targetRoute`,
 * excluding the record being saved. Enforces GLOBAL per-locale slug uniqueness: two pageLike records may
 * never resolve to the same static route (one route = one output file). Scanning resolved routes (not raw
 * `(path, locale)`) is what makes it correct for the non-injective cases — a primary-locale row whose bare
 * path looks prefixed (`/de/x`) aliases a `de`-locale row's `/x`, and a stored path with/without a leading
 * slash normalizes the same. O(pageLike rows): a single-user admin save, the same scope the publisher walks.
 * @public
 */
export function findRouteConflict(
  db: BetterSQLite3Database,
  targetRoute: string,
  primary: string,
  collections: BuiltCollection[],
  exclude: { collection: string; id: number | null },
  prefixPrimary = false,
): RouteConflict | null {
  for (const c of collections) {
    if (!c.def.pageLike) continue
    const cols = getTableColumns(c.table) as Record<string, never>
    const proj: Record<string, unknown> = { id: cols.id, path: cols.path }
    if (c.def.translatable) proj.locale = cols.locale
    const rows = db.select(proj as never).from(c.table).all() as { id: number; path: unknown; locale?: unknown }[]
    for (const r of rows) {
      if (c.name === exclude.collection && r.id === exclude.id) continue
      if (routeOf(r, !!c.def.translatable, primary, prefixPrimary) === targetRoute) return { collection: c.name, id: r.id }
    }
  }
  return null
}
