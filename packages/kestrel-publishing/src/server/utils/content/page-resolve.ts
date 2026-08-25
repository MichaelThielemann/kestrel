import { and, asc, eq, getTableColumns } from 'drizzle-orm'
import { captureRead, list, pagePathTag, translationGroupTag } from '@kestrel/core'
import type { BuiltCollection } from '@kestrel/core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

/** @public */
export interface PageAlternate { locale: string; path: string }
/** One published page above this one in the path hierarchy — a real, linkable breadcrumb step. */
/** @public */
export interface PageAncestor {
  path: string
  title?: string
  /** The ancestor's OWN locale, so the crumb builds the URL that was actually published. Absent for a
   *  non-translatable collection, whose rows have a single unprefixed (primary-locale) URL — prefixing
   *  one of those with the reader's locale would link a page `nuxt generate` never wrote. */
  locale?: string
}
/** @public */
export interface ResolvedPage {
  collection: string
  page: Record<string, unknown>
  alternates: PageAlternate[]
  ancestors: PageAncestor[]
}

/** The matched page (or null) plus the collections whose lookup threw. `failed` is non-empty ⇒ the scan
 *  was INCOMPLETE, so `page: null` must never be treated as an authoritative "no such page". */
/** @public */
export interface PageResolution {
  page: ResolvedPage | null
  failed: string[]
}

/**
 * The page's published, INDEXABLE translation siblings (self included) as locale→path pairs — the hreflang
 * set the public head emits. Mirrors the sitemap's rules exactly so the two never disagree: published-only
 * (a draft URL must never be advertised to crawlers), `seo.noindex` variants EXCLUDED (advertising an
 * hreflang to a noindexed page is a conflicting signal), null-path rows skipped, and a single-member group
 * returns [] (hreflang is meaningless for a lone page). EVERY sibling in the group is `captureRead`-tagged,
 * filtered-out ones included, so an incremental publish re-renders every group member when a sibling is
 * renamed/published/unpublished — otherwise a baked page would keep a stale/dead hreflang href. The GROUP
 * itself is tagged too: a sibling that does not exist yet has no id to have been captured, so the group tag
 * is the only edge a later CREATE can match.
 */
function publishedAlternates(db: BetterSQLite3Database, c: BuiltCollection, page: Record<string, unknown>): PageAlternate[] {
  if (c.def.mode !== 'multi' || !c.def.translatable) return []
  const group = page.translationGroup
  if (typeof group !== 'string' || !group) return []
  captureRead(translationGroupTag(c.def.name, group))
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

/** Every strict path prefix of a page's path, outermost first: `/blog/hello` → `['/', '/blog']`. The
 *  site root is an ancestor of everything except itself. */
function ancestorPaths(path: string): string[] {
  if (path === '/' || !path.startsWith('/')) return []
  const segments = path.split('/').filter(Boolean)
  const paths = ['/']
  for (let i = 1; i < segments.length; i += 1) paths.push(`/${segments.slice(0, i).join('/')}`)
  return paths
}

/**
 * The page's breadcrumb trail: the published, INDEXABLE page at each ancestor path, in the page's own
 * locale. A path segment with no page behind it is SKIPPED rather than synthesised — schema.org
 * breadcrumb items are links, and a trail that points at a 404 is a worse signal than a shorter trail.
 * The filters mirror the sitemap's, so a breadcrumb never advertises what the sitemap withholds.
 *
 * TWO dependency edges are captured per ancestor, because neither covers the other:
 *  - the PATH (`pagePathTag`), for every path looked in — including those with no page at all and those
 *    whose lookup threw. Kestrel has no parent/child relation between pages, so an ancestor is a
 *    path-prefix match, and a page CREATED at `/blog` after `/blog/hello` was published has no id anything
 *    could have captured beforehand. A path is knowable before its page exists.
 *  - the RECORD (`<coll>:<id>`) of whatever row sits there, captured before the filters below so a
 *    currently-invisible one counts too — the edge that carries a rename, a `noindex` or an unpublish,
 *    none of which `crumbTags` can see (see the comment at that capture).
 * `publishedAlternates` pairs a group tag with a record tag for exactly the same reason.
 */
function publishedAncestors(
  db: BetterSQLite3Database,
  collections: BuiltCollection[],
  path: string,
  locale: string | undefined,
  publishedOnly: boolean,
): PageAncestor[] {
  const out: PageAncestor[] = []
  for (const ancestorPath of ancestorPaths(path)) {
    // Before the scan, so the edge exists whatever the scan finds — no page, a draft, a noindexed one, or
    // a collection whose table could not be read. A write at this path emits the same tag (`crumbTags` in
    // classifyWrite), which is what repairs this page's trail.
    captureRead(pagePathTag(ancestorPath))
    for (const c of collections) {
      if (!c.def.pageLike) continue
      // Project only what a crumb needs — never the row: this runs once per path segment per render, and
      // pulling every page's block JSON to read a title would multiply the cost of a full publish.
      const cols = getTableColumns(c.table) as Record<string, never>
      const hasStatus = Object.hasOwn(cols, 'status')
      const proj: Record<string, unknown> = { id: cols.id, path: cols.path }
      if (hasStatus) proj.status = cols.status
      if (c.def.seo) proj.seo = cols.seo
      if (c.def.translatable) proj.locale = cols.locale
      if (Object.hasOwn(cols, 'title')) proj.title = cols.title
      const scoped = c.def.translatable && locale ? and(eq(cols.path, ancestorPath), eq(cols.locale, locale)) : eq(cols.path, ancestorPath)
      let row: { id: number; status?: string; seo?: { title?: string; noindex?: boolean } | null; title?: unknown; locale?: string } | undefined
      try {
        // Order by locale so an unscoped lookup (no locale requested) still answers deterministically
        // rather than with whatever row the table happens to yield first.
        const q = db.select(proj as never).from(c.table).where(scoped)
        row = (c.def.translatable ? q.orderBy(asc(cols.locale)) : q).limit(1).get() as typeof row
      } catch (error) {
        // Same isolation rule as the main scan: a drifted collection loses its crumbs, loudly, instead of
        // failing the whole render.
        console.error(`[kestrel] resolvePage: skipped ancestor lookup in ${c.def.name}:`, (error as Error)?.message ?? error)
        continue
      }
      if (!row) continue
      // BOTH edges are needed, and neither subsumes the other — the same pairing `publishedAlternates`
      // uses. The record tag covers every change to the row sitting here, INCLUDING the ones that make it
      // stop being a crumb: the explicit publish action classifies its write as `before === after` (the
      // record's current state), so a rename, a `noindex` or an unpublish is invisible in `crumbTags`,
      // which only ever names where the record is NOW. `<coll>:<id>` is in that write's tag list whatever
      // the row looks like, so it is what repairs the trail. Captured BEFORE the filters below, so a
      // draft/noindexed/shadowing row — one that is currently NOT the crumb — still carries the edge that
      // fires when it goes away.
      captureRead(c.def.name, row.id)
      if (publishedOnly && hasStatus && row.status !== 'published') break
      if (row.seo?.noindex) break
      const ancestor: PageAncestor = { path: ancestorPath }
      const title = row.seo?.title || (typeof row.title === 'string' ? row.title : undefined)
      if (title) ancestor.title = title
      if (c.def.translatable && row.locale) ancestor.locale = row.locale
      out.push(ancestor)
      break
    }
  }
  return out
}

/**
 * The first page-like record (across all collections, in registration order) whose `path` matches,
 * populated at depth 1 — or null, alongside the collections that could not be read at all. Reuses the
 * access-scoped `list()` so media/links populate exactly as a direct collection read would.
 * `publishedOnly` defaults true: a static render (prerender / runtime publisher) and an anonymous live
 * request must never see drafts. The authenticated-admin live preview passes false to surface a draft at
 * its real URL. Registration order is the precedence rule when two page-like collections happen to share
 * a path.
 * @public
 */
export function resolvePage(db: BetterSQLite3Database, collections: BuiltCollection[], path: string, locale?: string, publishedOnly = true): PageResolution {
  const failed: string[] = []
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
      failed.push(c.def.name)
      console.error(`[kestrel] resolvePage: skipped collection ${c.def.name}:`, (error as Error)?.message ?? error)
      continue
    }
    const { data } = result
    if (data.length) {
      captureRead(c.def.name, (data[0] as { id?: number }).id ?? null)
      return {
        page: {
          collection: c.def.name,
          page: data[0]!,
          alternates: publishedAlternates(db, c, data[0]!),
          ancestors: publishedAncestors(db, collections, path, locale, publishedOnly),
        },
        failed,
      }
    }
  }
  return { page: null, failed }
}
