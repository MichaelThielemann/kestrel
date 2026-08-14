import { getTableColumns } from 'drizzle-orm'
import { localePath } from '../../../core/app/utils/locale-path'
import type { LlmsSection, LlmsEntry } from '../utils/llms'

// Generates an `llms.txt` (llmstxt.org): the site name + description, then one section per pageLike
// collection listing its published, indexable records — the SAME registry-driven public set the sitemap
// advertises (single source: the auth policy). Safe to serve publicly and to prerender.
export default defineEventHandler((event) => {
  const db = useDb()
  const base = siteBaseUrl()
  const primary = primaryLocale()
  const prefixPrimary = prefixPrimaryLocale()

  const pub = publicReadableResources()
  const sections: LlmsSection[] = []
  // Without an absolute origin, every resource URL would be a relative path — omit the page sections (keep
  // the site name + description) rather than emit a link list that resolves against the wrong host.
  if (!base) console.warn('[kestrel] llms.txt: siteUrl is unset — omitting page links (they would be relative)')
  for (const c of base ? allCollections() : []) {
    if (!c.def.pageLike) continue
    if (!isPubliclyReadable(c.def.name, pub)) continue
    // Project ONLY the columns this listing reads — never SELECT *, which would pull every row's
    // block-content JSON into memory just to emit a link; the runtime publisher re-renders this route on
    // every incremental publish. Optional columns exist only when the def declares them (buildTable adds no
    // locale/status/seo column otherwise), and a `cols.<missing>` would be undefined and make the select
    // throw — gate on the same flags, as the sitemap does. `title` is a plain field, so probe the table.
    const cols = getTableColumns(c.table) as Record<string, never>
    const proj: Record<string, unknown> = { path: cols.path }
    if (c.def.translatable) proj.locale = cols.locale
    if (c.def.status) proj.status = cols.status
    if (c.def.seo) proj.seo = cols.seo
    if (Object.hasOwn(cols, 'title')) proj.title = cols.title
    let rows: Record<string, unknown>[]
    try {
      rows = db.select(proj as never).from(c.table).all() as Record<string, unknown>[]
    } catch (error) {
      // Skipping keeps a bare prerender DB publishable, but a drifted table drops the whole section — a
      // silent gap the publisher would write straight over the live artifact.
      console.error(`[kestrel] llms.txt: skipped collection ${c.def.name}:`, (error as Error)?.message ?? error)
      continue
    }
    const entries: LlmsEntry[] = []
    for (const row of rows) {
      if (c.def.status && row.status !== 'published') continue
      const path = row.path as string | null
      if (!path) continue
      const seo = (row.seo ?? {}) as { title?: string; description?: string; noindex?: boolean }
      if (seo.noindex) continue
      const locale = (row.locale as string | undefined) ?? primary
      entries.push({
        title: seo.title || (row.title as string | undefined) || path,
        url: base + localePath(path, locale, primary, prefixPrimary),
        description: seo.description || undefined,
      })
    }
    if (entries.length) {
      entries.sort((a, b) => a.url.localeCompare(b.url))
      sections.push({ heading: collectionHeading(c.def, primary), entries })
    }
  }

  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return buildLlmsTxt({ siteName: siteName(), siteDescription: siteDescription() || undefined, sections })
})
