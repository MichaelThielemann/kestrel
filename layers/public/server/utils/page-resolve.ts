import { asc, eq, getTableColumns } from 'drizzle-orm'
import { list } from '../../../core/server/utils/crud'
import { captureRead } from '../../../core/server/utils/read-capture'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

export interface PageAlternate { locale: string; path: string }
export interface ResolvedPage { collection: string; page: Record<string, unknown>; alternates: PageAlternate[] }

/**
 * The page's published, INDEXABLE translation siblings (self included) as locale→path pairs — the hreflang
 * set the public head emits. Mirrors the sitemap's rules exactly so the two never disagree: published-only
 * (a draft URL must never be advertised to crawlers), `seo.noindex` variants EXCLUDED (advertising an
 * hreflang to a noindexed page is a conflicting signal), null-path rows skipped, and a single-member group
 * returns [] (hreflang is meaningless for a lone page). EVERY sibling in the group is `captureRead`-tagged,
 * filtered-out ones included, so an incremental publish re-renders every group member when a sibling is
 * renamed/published/unpublished — otherwise a baked page would keep a stale/dead hreflang href.
 */
function publishedAlternates(db: BetterSQLite3Database, c: BuiltCollection, page: Record<string, unknown>): PageAlternate[] {
  if (c.def.mode !== 'multi' || !c.def.translatable) return []
  const group = page.translationGroup
  if (typeof group !== 'string' || !group) return []
  const cols = getTableColumns(c.table) as Record<string, never>
  // A status-less pageLike collection has no draft state — every sibling is "published".
  const hasStatus = Object.hasOwn(cols, 'status')
  const proj: Record<string, unknown> = { id: cols.id, locale: cols.locale, path: cols.path }
  if (hasStatus) proj.status = cols.status
  if (c.def.seo) proj.seo = cols.seo
  // Read the WHOLE group and filter in JS: a row excluded by SQL is never captured, so a draft sibling
  // would carry no dependency edge for the publish tag `<coll>:<id>` to match, and this page would keep a
  // baked hreflang set missing the newly-published sibling until the next full generate.
  const rows = db.select(proj as never)
    .from(c.table)
    .where(eq(cols.translationGroup, group))
    .orderBy(asc(cols.locale))
    .all() as Array<{ id: number; locale: string; path: unknown; status?: string; seo?: { noindex?: boolean } | null }>
  const alternates: PageAlternate[] = []
  let selfAdvertisable = false
  for (const r of rows) {
    // Capture the sibling as a publish dependency even if it is filtered out below — a draft/noindexed/
    // null-path sibling that later becomes advertisable must still re-render this page's hreflang set.
    captureRead(c.def.name, r.id)
    if (hasStatus && r.status !== 'published') continue // a draft URL must never be advertised
    if (typeof r.path !== 'string' || !r.path) continue // null/empty path — no advertisable URL
    if (r.seo?.noindex) continue // noindexed — never advertise it via hreflang (matches the sitemap)
    if (r.id === page.id) selfAdvertisable = true
    alternates.push({ locale: r.locale, path: r.path })
  }
  // A hreflang set with no self-reference is a signal search engines ignore wholesale — if the page
  // being rendered didn't itself survive the filters above, advertise nothing rather than an orphan set.
  if (!selfAdvertisable) return []
  return alternates.length >= 2 ? alternates : []
}

/**
 * The first page-like record (across all collections, in registration order) whose `path` matches,
 * populated at depth 1 — or null. Reuses the access-scoped `list()` so media/links populate exactly as
 * a direct collection read would. `publishedOnly` defaults true: a static render (prerender / runtime
 * publisher) and an anonymous live request must never see drafts. The authenticated-admin live preview
 * passes false to surface a draft at its real URL. Registration order is the precedence rule when two
 * page-like collections happen to share a path.
 */
export function resolvePage(db: BetterSQLite3Database, collections: BuiltCollection[], path: string, locale?: string, publishedOnly = true): ResolvedPage | null {
  for (const c of collections) {
    if (!c.def.pageLike) continue
    // withTotal:false — read only the first row, skip count(). capture:false — don't tag the whole
    // collection here (the self-lookup is by path); instead tag the found record below, so this page
    // depends on its OWN record, not on every sibling in the collection (precise invalidation).
    let result: ReturnType<typeof list>
    try {
      result = list(db, c, { filter: [{ field: 'path', op: 'eq', value: path }], locale, depth: 1, perPage: 1, withTotal: false, capture: false }, publishedOnly)
    } catch (error) {
      // Table not migrated yet (e.g. a bare prerender DB) — isolate this collection's drift from the rest,
      // but never silently: an unread collection is indistinguishable from one with no matching page, and
      // the publisher would write a 404 over every one of its routes.
      console.error(`[kestrel] resolvePage: skipped collection ${c.def.name}:`, (error as Error)?.message ?? error)
      continue
    }
    const { data } = result
    if (data.length) {
      captureRead(c.def.name, (data[0] as { id?: number }).id ?? null)
      return { collection: c.def.name, page: data[0]!, alternates: publishedAlternates(db, c, data[0]!) }
    }
  }
  return null
}
