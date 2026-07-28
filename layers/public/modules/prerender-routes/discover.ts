import type Database from 'better-sqlite3'
import { pagesToRoutes, type PageRouteRow } from './routes'

/** Tables the schema engine marked routable, by their partial `path` index (see `collectPageRoutes`).
 *  Empty means this file holds no page-like collection at all — a structural fact about the schema, not a
 *  statement about how many pages exist: a CMS with one page still has its table and that index. */
export function pageLikeTables(db: Database.Database): string[] {
  return (db
    .prepare("SELECT DISTINCT tbl_name AS name FROM sqlite_master WHERE type = 'index' AND sql LIKE '%path is not null%'")
    .all() as { name: string }[]).map((t) => t.name)
}

/**
 * Page routes to seed for `nuxt generate`, discovered straight from the build-time DB (no registry is
 * available at build). Every page-like collection carries a **partial unique index on `path`**
 * (`… WHERE path is not null`) — the schema engine's marker for a routable table — so we enumerate those.
 * That is reliable where "has a `path` column" is NOT: the media `folders` registry has a `path` column +
 * a plain unique index, but no such partial clause, so it is correctly excluded. Per pageLike table:
 * published rows (only where a `status` column exists) with a non-null path, keyed by their own `locale`
 * (or the primary locale for a non-translatable collection). Returns the deduped, sorted route list
 * (always including the root).
 */
export function collectPageRoutes(db: Database.Database, primaryLocale: string, prefixPrimary = false): string[] {
  const rows: PageRouteRow[] = []
  for (const name of pageLikeTables(db)) {
    const q = `"${name.replace(/"/g, '""')}"`
    const cols = (db.prepare(`PRAGMA table_info(${q})`).all() as { name: string }[]).map((c) => c.name)
    const statusClause = cols.includes('status') ? "status = 'published' AND " : ''
    if (cols.includes('locale')) {
      rows.push(...(db.prepare(`SELECT path, locale FROM ${q} WHERE ${statusClause}path IS NOT NULL`).all() as PageRouteRow[]))
    } else {
      const bare = db.prepare(`SELECT path FROM ${q} WHERE ${statusClause}path IS NOT NULL`).all() as { path: string | null }[]
      for (const r of bare) rows.push({ path: r.path, locale: primaryLocale })
    }
  }
  return pagesToRoutes(rows, primaryLocale, prefixPrimary)
}
