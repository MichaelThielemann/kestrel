import { describe, it, expect } from 'vitest'
import { buildJsonLd } from './json-ld'

const base = {
  siteUrl: 'https://example.com/',
  siteName: 'Example',
  canonical: 'https://example.com/about',
  path: '/about',
  locale: 'en',
  primary: 'en',
  prefixPrimary: false,
  title: 'About us',
  description: 'Who we are',
}

const graphOf = (input: Parameters<typeof buildJsonLd>[0]) => buildJsonLd(input)?.['@graph'] ?? []
const nodeOf = (input: Parameters<typeof buildJsonLd>[0], type: string) =>
  graphOf(input).find((n) => (n as { '@type': string })['@type'] === type) as Record<string, unknown> | undefined

describe('buildJsonLd', () => {
  it('emits a schema.org graph with a WebSite and a WebPage', () => {
    expect(buildJsonLd(base)).toEqual({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': 'https://example.com/#website', url: 'https://example.com/', name: 'Example' },
        {
          '@type': 'WebPage',
          '@id': 'https://example.com/about#webpage',
          url: 'https://example.com/about',
          name: 'About us',
          description: 'Who we are',
          inLanguage: 'en',
          isPartOf: { '@id': 'https://example.com/#website' },
        },
      ],
    })
  })

  it('attaches the already-absolute social image as the page image', () => {
    expect(nodeOf({ ...base, imageUrl: 'https://cdn.example.net/a.webp' }, 'WebPage')!.image)
      .toBe('https://cdn.example.net/a.webp')
  })

  it('omits the WebSite node and the isPartOf edge when the site has no name', () => {
    const graph = graphOf({ ...base, siteName: '' })
    expect(graph).toHaveLength(1)
    expect(graph[0]).not.toHaveProperty('isPartOf')
  })

  it('emits nothing at all without an absolute canonical — every @id would be relative', () => {
    expect(buildJsonLd({ ...base, siteUrl: '', canonical: undefined })).toBeNull()
  })

  it('emits nothing for a noindex page: structured data exists to be indexed', () => {
    expect(buildJsonLd({ ...base, noindex: true })).toBeNull()
  })

  it('builds a BreadcrumbList from the published ancestors plus the page itself', () => {
    const input = {
      ...base,
      path: '/blog/hello',
      canonical: 'https://example.com/blog/hello',
      title: 'Hello',
      ancestors: [{ title: 'Home', path: '/' }, { title: 'Blog', path: '/blog' }],
    }
    expect(nodeOf(input, 'BreadcrumbList')).toEqual({
      '@type': 'BreadcrumbList',
      '@id': 'https://example.com/blog/hello#breadcrumb',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://example.com/blog' },
        { '@type': 'ListItem', position: 3, name: 'Hello', item: 'https://example.com/blog/hello' },
      ],
    })
    expect(nodeOf(input, 'WebPage')!.breadcrumb).toEqual({ '@id': 'https://example.com/blog/hello#breadcrumb' })
  })

  it('builds each ancestor URL from the ancestor’s OWN locale, falling back to the primary', () => {
    const crumbsOf = (ancestors: Array<{ title?: string; path: string; locale?: string }>) =>
      (nodeOf({ ...base, locale: 'de', path: '/ueber-uns', canonical: 'https://example.com/de/ueber-uns', ancestors: [...ancestors, { title: 'x', path: '/x' }] }, 'BreadcrumbList')!
        .itemListElement as Array<Record<string, unknown>>)
    // a translatable ancestor carries its locale, and it is prefixed like every other page in it
    expect(crumbsOf([{ title: 'Start', path: '/', locale: 'de' }])[0]!.item).toBe('https://example.com/de')
    // a non-translatable one has no locale: its only published URL is the primary-locale (unprefixed) one,
    // so prefixing it with the reader's locale would link a file `nuxt generate` never wrote
    expect(crumbsOf([{ title: 'Promo', path: '/promo' }])[0]!.item).toBe('https://example.com/promo')
  })

  it('omits a one-item breadcrumb — a trail to the page you are on says nothing', () => {
    expect(nodeOf(base, 'BreadcrumbList')).toBeUndefined()
    expect(nodeOf({ ...base, ancestors: [] }, 'BreadcrumbList')).toBeUndefined()
  })

  it('names an ancestor by its path when it carries no title', () => {
    const crumbs = nodeOf({ ...base, ancestors: [{ path: '/blog' }] }, 'BreadcrumbList')!
      .itemListElement as Array<Record<string, unknown>>
    expect(crumbs[0]!.name).toBe('/blog')
  })

  it('upgrades the page to an Article when article metadata is supplied', () => {
    expect(nodeOf({ ...base, article: { author: 'Ada Lovelace', publishedDate: '2026-01-15', keywords: 'notes, math' } }, 'Article'))
      .toEqual({
        '@type': 'Article',
        '@id': 'https://example.com/about#webpage',
        url: 'https://example.com/about',
        headline: 'About us',
        description: 'Who we are',
        inLanguage: 'en',
        isPartOf: { '@id': 'https://example.com/#website' },
        author: { '@type': 'Person', name: 'Ada Lovelace' },
        datePublished: '2026-01-15',
        keywords: 'notes, math',
      })
  })

  it('emits only the article properties that are actually set', () => {
    const node = nodeOf({ ...base, article: { publishedDate: '2026-01-15' } }, 'Article')!
    expect(node.datePublished).toBe('2026-01-15')
    expect(node).not.toHaveProperty('author')
    expect(node).not.toHaveProperty('keywords')
  })

  it('stays a WebPage when the article bag is absent or carries nothing usable', () => {
    expect(nodeOf({ ...base, article: null }, 'WebPage')).toBeDefined()
    expect(nodeOf({ ...base, article: { author: '  ', publishedDate: '', keywords: '' } }, 'WebPage')).toBeDefined()
  })

  it('ignores a publishedDate that is not an ISO date rather than emitting an invalid one', () => {
    const node = nodeOf({ ...base, article: { author: 'Ada', publishedDate: 'last tuesday' } }, 'Article')!
    expect(node).not.toHaveProperty('datePublished')
  })

  it('omits title and description when the page has none', () => {
    const node = nodeOf({ ...base, title: undefined, description: undefined }, 'WebPage')!
    expect(node).not.toHaveProperty('name')
    expect(node).not.toHaveProperty('description')
  })
})
