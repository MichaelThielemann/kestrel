import { getTableColumns } from 'drizzle-orm'
import { localePath } from '../../../core/app/utils/locale-path'

// Lists every published, indexable page-like record (across all pageLike collections) as a
// sitemap. Filters status/noindex itself, so it is safe to serve publicly and to prerender.
export default defineEventHandler((event) => {
  const db = useDb()
  const base = siteBaseUrl()
  // Without an absolute origin (kestrel.siteUrl / KESTREL_SITE_URL) every <loc> would be a RELATIVE path,
  // which the sitemaps.org schema rejects outright — a worse result than an empty sitemap. Emit a valid
  // empty one + warn, mirroring robots.txt omitting its `Sitemap:` directive when the base is unset.
  if (!base) {
    console.warn('[kestrel] sitemap.xml: siteUrl is unset — emitting an empty sitemap (relative <loc> URLs would be invalid)')
    setHeader(event, 'content-type', 'application/xml; charset=utf-8')
    return buildSitemap([])
  }
  const primary = primaryLocale()
  const prefixPrimary = prefixPrimaryLocale()
  const candidates: SitemapCandidate[] = []

  // A sitemap must only advertise publicly-reachable URLs. The public render path (anonymous access
  // policy, prerender seed, catch-all) now renders every pageLike collection, so the sitemap tracks the
  // SAME registry-driven public set (single source: the auth policy) rather than diverging from it.
  const pub = publicReadableResources()
  for (const c of allCollections()) {
    if (!c.def.pageLike) continue
    if (!isPubliclyReadable(c.def.name, pub)) continue
    // Project ONLY the columns the sitemap reads — never SELECT *, which would pull every row's
    // block-content JSON (and every other field) into memory just to emit a URL; the runtime publisher
    // re-renders this route on every incremental publish. Optional columns exist only when the def
    // declares them (buildTable adds no locale/status/seo column otherwise), and a `cols.<missing>` would
    // be undefined and make the select throw — gate on the same flags, as allPublishedRoutes does.
    const cols = getTableColumns(c.table) as Record<string, never>
    const proj: Record<string, unknown> = { path: cols.path, updatedAt: cols.updatedAt }
    if (c.def.translatable) proj.locale = cols.locale
    if (c.def.translatable && c.def.mode !== 'single') proj.translationGroup = cols.translationGroup
    if (c.def.status) proj.status = cols.status
    if (c.def.seo) proj.seo = cols.seo
    let rows: Record<string, unknown>[]
    try {
      rows = db.select(proj as never).from(c.table).all() as Record<string, unknown>[]
    } catch {
      continue // table not migrated yet (e.g. a bare prerender DB)
    }
    for (const row of rows) {
      if (c.def.status && row.status !== 'published') continue
      const path = row.path as string | null
      if (!path) continue
      const seo = (row.seo ?? {}) as { noindex?: boolean }
      if (seo.noindex) continue
      const locale = (row.locale as string | undefined) ?? primary
      candidates.push({
        loc: base + localePath(path, locale, primary, prefixPrimary),
        lastmod: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : undefined,
        locale,
        group: (row.translationGroup as string | undefined) ?? null,
      })
    }
  }

  // Link each page's published, indexable locale variants via hreflang alternates before serializing.
  const entries = withHreflang(candidates, primary)
  entries.sort((a, b) => a.loc.localeCompare(b.loc))
  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  return buildSitemap(entries)
})
