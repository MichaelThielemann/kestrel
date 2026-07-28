export interface SitemapAlternate {
  hreflang: string
  href: string
}

export interface SitemapEntry {
  loc: string
  lastmod?: string
  alternates?: SitemapAlternate[]
}

/** A page-like row reduced to what the sitemap needs, before grouping translations into hreflang sets. */
export interface SitemapCandidate {
  loc: string
  lastmod?: string
  locale: string
  /** The translation-group key, or null/undefined for rows that have no localized siblings. */
  group?: string | null
}

/** Drop any trailing slashes from a site base URL so `base + path` never doubles up. */
export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '')
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Group page-like candidates into `<url>` entries, attaching the hreflang alternate set to every
 * member of a multi-locale translation group. Pure: the route feeds it published+indexable rows only,
 * so alternates never advertise a draft/noindex variant. Order is preserved (the route sorts after).
 * A group of one (or a row with no group) gets no alternates — hreflang is meaningless for a lone page.
 * `x-default` points at the primary-locale variant when that variant is part of the group.
 */
export function withHreflang(candidates: SitemapCandidate[], primaryLocale: string): SitemapEntry[] {
  const groups = new Map<string, SitemapCandidate[]>()
  for (const c of candidates) {
    if (c.group == null) continue
    const arr = groups.get(c.group)
    if (arr) arr.push(c)
    else groups.set(c.group, [c])
  }

  return candidates.map((c) => {
    const entry: SitemapEntry = { loc: c.loc }
    if (c.lastmod) entry.lastmod = c.lastmod
    const variants = c.group != null ? groups.get(c.group)! : []
    if (variants.length >= 2) entry.alternates = buildAlternates(variants, primaryLocale)
    return entry
  })
}

/** Sorted-by-locale alternate links for a group, plus an `x-default` to the primary variant if present. */
function buildAlternates(variants: SitemapCandidate[], primaryLocale: string): SitemapAlternate[] {
  const sorted = [...variants].sort((a, b) => a.locale.localeCompare(b.locale))
  const seen = new Set<string>()
  const alternates: SitemapAlternate[] = []
  for (const v of sorted) {
    if (seen.has(v.locale)) continue
    seen.add(v.locale)
    alternates.push({ hreflang: v.locale, href: v.loc })
  }
  const primary = sorted.find((v) => v.locale === primaryLocale)
  if (primary) alternates.push({ hreflang: 'x-default', href: primary.loc })
  return alternates
}

export function buildSitemap(entries: SitemapEntry[]): string {
  const hasAlternates = entries.some((e) => e.alternates && e.alternates.length > 0)
  const xhtmlNs = hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''
  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod ? `<lastmod>${xmlEscape(e.lastmod)}</lastmod>` : ''
      const links = (e.alternates ?? [])
        .map((a) => `<xhtml:link rel="alternate" hreflang="${xmlEscape(a.hreflang)}" href="${xmlEscape(a.href)}"/>`)
        .join('')
      return `<url><loc>${xmlEscape(e.loc)}</loc>${lastmod}${links}</url>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtmlNs}>${urls}</urlset>`
}

export function buildRobots(opts: { sitemapUrl?: string; llmsUrl?: string } = {}): string {
  const lines = ['User-agent: *', 'Allow: /']
  // A comment (robots.txt has no standard llms directive) so crawlers that read robots also find the
  // agent-oriented site map at /llms.txt. Kept above the blank-line-separated Sitemap directive.
  if (opts.llmsUrl) lines.push(`# llms.txt: ${opts.llmsUrl}`)
  if (opts.sitemapUrl) lines.push('', `Sitemap: ${opts.sitemapUrl}`)
  return `${lines.join('\n')}\n`
}
