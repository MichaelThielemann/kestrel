import { getTableColumns } from 'drizzle-orm'
import { localePath, useDb, primaryLocale, prefixPrimaryLocale, allCollections } from '@michaelthielemann/kestrel-core'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'
import { isPubliclyReadable, publicReadableResources } from '@michaelthielemann/kestrel-access'
import { LLMS_FULL_HEADING_OFFSET, buildLlmsFullTxt, recordMarkdown, collectionHeading, siteBaseUrl, siteName, siteDescription, llmsFullEnabled } from '@michaelthielemann/kestrel-publishing'
import type { LlmsFullSection, LlmsFullPage } from '@michaelthielemann/kestrel-publishing'
// The long form of llms.txt: every published, indexable page's full Markdown body in one document, so an
// answer engine can ground on the site without crawling it. Same registry-driven public set and the same
// status/noindex filters as `llms.txt` and the sitemap (single source: the auth policy).
//
// OPT-IN (`kestrel.seo.llmsFull`, default off), for two reasons that both matter: it aggregates the whole
// site into one scrapeable artifact — a disclosure decision that belongs to the consumer, not to an
// upgrade — and unlike `llms.txt` it must read every row's block content, which the publisher would
// re-render on every incremental publish.
export default defineEventHandler((event) => {
  if (!llmsFullEnabled()) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  const db = useDb()
  const base = siteBaseUrl()
  const primary = primaryLocale()
  const prefixPrimary = prefixPrimaryLocale()

  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  // Without an absolute origin every `Source:` line would be a relative path resolving against whatever
  // host fetched the file — the same rule `llms.txt` applies to its link list.
  if (!base) {
    console.warn('[kestrel] llms-full.txt: siteUrl is unset — omitting page bodies (their URLs would be relative)')
    return buildLlmsFullTxt({ siteName: siteName(), siteDescription: siteDescription() || undefined, sections: [] })
  }

  interface Loaded { c: BuiltCollection; rows: Record<string, unknown>[] }
  const pub = publicReadableResources()
  const loaded: Loaded[] = []
  for (const c of allCollections()) {
    if (!c.def.pageLike) continue
    if (!isPubliclyReadable(c.def.name, pub)) continue
    // Project the listing columns plus ONLY the prose-bearing fields — this route does have to read block
    // content, but a media/relation/json column still has no business being loaded to render text.
    const cols = getTableColumns(c.table) as Record<string, never>
    const proj: Record<string, unknown> = { id: cols.id, path: cols.path }
    if (c.def.translatable) proj.locale = cols.locale
    if (c.def.status) proj.status = cols.status
    if (c.def.seo) proj.seo = cols.seo
    if (c.def.blocks?.enabled) proj.content = cols.content
    for (const [key, field] of Object.entries(c.def.fields)) {
      if (field.type === 'text' || field.type === 'richtext' || field.type === 'repeater') proj[key] = cols[key]
    }
    try {
      loaded.push({ c, rows: db.select(proj as never).from(c.table).all() as Record<string, unknown>[] })
    } catch (error) {
      // Skipping keeps a bare prerender DB publishable, but a drifted table drops the whole section — a
      // silent gap the publisher would write straight over the live artifact.
      console.error(`[kestrel] llms-full.txt: skipped collection ${c.def.name}:`, (error as Error)?.message ?? error)
    }
  }

  const advertisable = (c: BuiltCollection, row: Record<string, unknown>): string | null => {
    if (c.def.status && row.status !== 'published') return null
    const path = row.path as string | null
    if (!path) return null
    if ((row.seo as { noindex?: boolean } | null)?.noindex) return null
    return base + localePath(path, (row.locale as string | undefined) ?? primary, primary, prefixPrimary)
  }

  // Internal richtext links are stored as `kestrel:<collection>:<id>` markers. Resolve them from the rows
  // already loaded — the same status/noindex gate, so a marker pointing at a draft or a noindexed page
  // declines and the link degrades to its own text instead of leaking an unpublished URL.
  const linkTargets = new Map<string, string>()
  for (const { c, rows } of loaded) {
    for (const row of rows) {
      const url = advertisable(c, row)
      if (url) linkTargets.set(`${c.def.name}:${row.id as number}`, url)
    }
  }
  const resolveLink = (collection: string, id: number): string | null => linkTargets.get(`${collection}:${id}`) ?? null

  const sections: LlmsFullSection[] = []
  for (const { c, rows } of loaded) {
    const pages: LlmsFullPage[] = []
    for (const row of rows) {
      const url = advertisable(c, row)
      if (!url) continue
      const seo = (row.seo ?? {}) as { title?: string; description?: string }
      pages.push({
        title: seo.title || (row.title as string | undefined) || (row.path as string),
        url,
        description: seo.description || undefined,
        // `title` already IS this page's heading — emitting it again as body text would repeat every
        // page title twice in the document.
        body: recordMarkdown(c.def, row, { headingOffset: LLMS_FULL_HEADING_OFFSET, skipFields: ['title'], resolveLink }),
      })
    }
    if (pages.length) {
      pages.sort((a, b) => a.url.localeCompare(b.url))
      sections.push({ heading: collectionHeading(c.def, primary), pages })
    }
  }

  return buildLlmsFullTxt({ siteName: siteName(), siteDescription: siteDescription() || undefined, sections })
})
