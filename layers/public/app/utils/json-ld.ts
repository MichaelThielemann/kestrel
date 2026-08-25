import { localePath } from '@kestrel/core/client'

/** One published ancestor of the rendered page, outermost first — the breadcrumb trail. */
export interface JsonLdAncestor {
  /** The ancestor's own path, unprefixed (the emitter locale-prefixes it, as `buildPageHead` does). */
  path: string
  title?: string
  /** The ancestor's OWN locale. Absent for a record in a non-translatable collection, whose single
   *  published URL is the primary-locale one — the same `row.locale ?? primary` rule the sitemap uses. */
  locale?: string
}

/** The opt-in article metadata (`kestrel.seo.articleMeta`). Absent ⇒ the page stays a plain `WebPage`
 *  and no authorship or date is published — the default, and the only behaviour a consumer who never
 *  turns the flag on can get. */
export interface JsonLdArticle {
  author?: string
  /** ISO date (`YYYY-MM-DD`) or ISO datetime; anything else is dropped rather than emitted invalid. */
  publishedDate?: string
  /** Free-form comma-separated list — schema.org accepts that spelling for `keywords` verbatim. */
  keywords?: string
}

export interface JsonLdInput {
  /** Absolute site origin ('' when unconfigured). */
  siteUrl: string
  siteName?: string
  /** The page's absolute canonical URL (from `buildPageHead`); absent ⇒ nothing is emitted. */
  canonical?: string
  locale: string
  primary: string
  prefixPrimary: boolean
  title?: string
  description?: string
  /** The already-absolute og:image URL, so the image-resolution rules live in one place. */
  imageUrl?: string
  /** Excluded from the graph entirely — see `buildJsonLd`. */
  noindex?: boolean
  ancestors?: JsonLdAncestor[]
  article?: JsonLdArticle | null
}

/** A type alias, not an interface, for the same reason as `PageHeadLink`: unhead's `script` entry types
 *  `textContent` as `string | Record<string, unknown>`, and TS derives the implicit index signature that
 *  needs for an alias but never for an interface. */
export type JsonLd = {
  '@context': 'https://schema.org'
  '@graph': Record<string, unknown>[]
}

const trimmed = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || undefined
}

// schema.org dates are ISO 8601; an editor free-text value that is not one would be published as a
// broken `datePublished`, which is worse for a consuming engine than no date at all.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]|$)/

/**
 * The JSON-LD graph for a rendered public page: a site-wide `WebSite`, the page itself as a `WebPage`
 * (or an `Article`, when the consumer opted into article metadata AND the record carries some), and a
 * `BreadcrumbList` built from the page's real published ancestors. Pure, like `buildPageHead`, and fed
 * the same already-resolved values — the precedence chain stays outside (ADR-0007).
 *
 * Two whole-graph veto rules, both because the alternative is a false signal rather than a missing one:
 * without an absolute canonical every `@id`/`url` would be a relative path that resolves against
 * whatever host fetched it, and a `noindex` page asking to be excluded from search has no business
 * shipping structured data that exists to be indexed.
 *
 * Breadcrumb items are REAL pages only (the resolver hands over the published ancestors it found), so a
 * trail never advertises an intermediate URL that 404s; a trail of one is dropped, since "you are here"
 * carries no information.
 */
export function buildJsonLd(input: JsonLdInput): JsonLd | null {
  const canonical = trimmed(input.canonical)
  if (!canonical || input.noindex) return null
  const base = input.siteUrl.replace(/\/+$/, '')
  const abs = (path: string, locale: string) => `${base}${localePath(path, locale, input.primary, input.prefixPrimary)}`

  const graph: Record<string, unknown>[] = []
  const siteName = trimmed(input.siteName)
  // A nameless WebSite node is an empty assertion — omit it, and with it the isPartOf edge that would
  // otherwise dangle at an @id nothing defines.
  const websiteId = siteName ? `${base}/#website` : undefined
  if (websiteId) graph.push({ '@type': 'WebSite', '@id': websiteId, url: `${base}/`, name: siteName })

  const article = usableArticle(input.article)
  const page: Record<string, unknown> = {
    '@type': article ? 'Article' : 'WebPage',
    '@id': `${canonical}#webpage`,
    url: canonical,
  }
  const title = trimmed(input.title)
  // `headline` is the Article spelling of the same value; keeping them apart avoids a node that claims
  // both and matches what validators expect per type.
  if (title) page[article ? 'headline' : 'name'] = title
  const description = trimmed(input.description)
  if (description) page.description = description
  page.inLanguage = input.locale
  if (websiteId) page.isPartOf = { '@id': websiteId }
  const imageUrl = trimmed(input.imageUrl)
  if (imageUrl) page.image = imageUrl
  if (article) {
    if (article.author) page.author = { '@type': 'Person', name: article.author }
    if (article.publishedDate) page.datePublished = article.publishedDate
    if (article.keywords) page.keywords = article.keywords
  }

  const crumbs = [
    ...(input.ancestors ?? []).map((a) => ({ name: trimmed(a.title) ?? a.path, item: abs(a.path, a.locale ?? input.primary) })),
    { name: title ?? canonical, item: canonical },
  ]
  if (crumbs.length >= 2) {
    const breadcrumbId = `${canonical}#breadcrumb`
    page.breadcrumb = { '@id': breadcrumbId }
    graph.push(page, {
      '@type': 'BreadcrumbList',
      '@id': breadcrumbId,
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })),
    })
  } else {
    graph.push(page)
  }

  return { '@context': 'https://schema.org', '@graph': graph }
}

/** The article bag reduced to the values worth publishing, or null — which keeps the node a `WebPage`.
 *  A bag of blanks (an editor who opened the fields and typed nothing) must not upgrade the type. */
function usableArticle(article: JsonLdArticle | null | undefined): Required<JsonLdArticle> | null {
  if (!article) return null
  const author = trimmed(article.author) ?? ''
  const rawDate = trimmed(article.publishedDate) ?? ''
  const publishedDate = ISO_DATE.test(rawDate) ? rawDate : ''
  const keywords = trimmed(article.keywords) ?? ''
  // An unparseable date alone must not upgrade the type either — nothing would be emitted from it.
  return author || publishedDate || keywords ? { author, publishedDate, keywords } : null
}
