export interface SiteHead {
  baseTitle?: string | null
  titleSeparator?: string | null
  titlePosition?: 'before' | 'after' | null
  description?: string | null
  $media?: { image?: { src: string, width: number | null, height: number | null } | null } | null
}

const DEFAULT_SEPARATOR = '|'

const trimmed = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || undefined
}

/**
 * The `<title>` for a page. Only the document title is composed — `og:title` keeps the bare page title,
 * because `og:site_name` already carries the site.
 */
export function composeTitle(pageTitle: string | undefined | null, site: SiteHead | null | undefined): string | undefined {
  const page = trimmed(pageTitle)
  const base = trimmed(site?.baseTitle)
  if (!base) return page
  if (!page) return base
  // Migrated content often carries the site name in the page title already; appending it again reads as a
  // bug to every visitor who looks at the tab.
  if (page === base || page.endsWith(base)) return page
  // The separator is stored as a bare token and padded here: a `text` field trims on write, so a stored
  // " | " would come back as "|" and glue the two titles together.
  const separator = trimmed(site?.titleSeparator) ?? DEFAULT_SEPARATOR
  return site?.titlePosition === 'before' ? `${base} ${separator} ${page}` : `${page} ${separator} ${base}`
}

/** The page wins, the site stands in, and both degrade to absent so the tags disappear entirely. */
export function siteHeadFallbacks(
  seo: { description?: string | null, $media?: { image?: { src: string, width: number | null, height: number | null } | null } | null } | null | undefined,
  site: SiteHead | null | undefined,
): { description?: string, image: { src: string, width: number | null, height: number | null } | null } {
  return {
    description: trimmed(seo?.description) ?? trimmed(site?.description),
    image: seo?.$media?.image ?? site?.$media?.image ?? null,
  }
}
