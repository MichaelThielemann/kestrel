import { describe, it, expect } from 'vitest'
import { normalizeBase, buildSitemap, buildRobots, withHreflang } from './sitemap'

describe('normalizeBase', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBase('https://x.com/')).toBe('https://x.com')
    expect(normalizeBase('https://x.com')).toBe('https://x.com')
    expect(normalizeBase('https://x.com///')).toBe('https://x.com')
    expect(normalizeBase('')).toBe('')
  })
})

describe('buildSitemap', () => {
  it('emits a urlset with escaped locs and optional lastmod', () => {
    const xml = buildSitemap([
      { loc: 'https://x.com/' },
      { loc: 'https://x.com/a?b=1&c=2', lastmod: '2026-06-18T00:00:00.000Z' },
    ])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(xml).toContain('<url><loc>https://x.com/</loc></url>')
    expect(xml).toContain('<loc>https://x.com/a?b=1&amp;c=2</loc>')
    expect(xml).toContain('<lastmod>2026-06-18T00:00:00.000Z</lastmod>')
    expect(xml.endsWith('</urlset>')).toBe(true)
  })

  it('handles an empty url list', () => {
    expect(buildSitemap([])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
    )
  })

  it('omits the xhtml namespace when no entry carries alternates', () => {
    const xml = buildSitemap([{ loc: 'https://x.com/' }])
    expect(xml).not.toContain('xmlns:xhtml')
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
  })

  it('declares the xhtml namespace and emits xhtml:link alternates when present', () => {
    const xml = buildSitemap([
      {
        loc: 'https://x.com/about',
        lastmod: '2026-06-23T00:00:00.000Z',
        alternates: [
          { hreflang: 'en', href: 'https://x.com/about' },
          { hreflang: 'de', href: 'https://x.com/de/ueber-uns' },
          { hreflang: 'x-default', href: 'https://x.com/about' },
        ],
      },
    ])
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">')
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="en" href="https://x.com/about"/>')
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="de" href="https://x.com/de/ueber-uns"/>')
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="https://x.com/about"/>')
  })

  it('escapes alternate hrefs', () => {
    const xml = buildSitemap([
      {
        loc: 'https://x.com/a',
        alternates: [
          { hreflang: 'en', href: 'https://x.com/a?b=1&c=2' },
          { hreflang: 'de', href: 'https://x.com/de/a' },
        ],
      },
    ])
    expect(xml).toContain('href="https://x.com/a?b=1&amp;c=2"')
  })
})

describe('withHreflang', () => {
  it('attaches the full, locale-sorted alternate set (+ x-default → primary) to every group member', () => {
    const entries = withHreflang(
      [
        { loc: 'https://x.com/de/ueber-uns', locale: 'de', group: 'g1', lastmod: 'L1' },
        { loc: 'https://x.com/about', locale: 'en', group: 'g1' },
      ],
      'en',
    )
    const en = entries.find((e) => e.loc === 'https://x.com/about')!
    expect(en.alternates).toEqual([
      { hreflang: 'de', href: 'https://x.com/de/ueber-uns' },
      { hreflang: 'en', href: 'https://x.com/about' },
      { hreflang: 'x-default', href: 'https://x.com/about' },
    ])
    const de = entries.find((e) => e.loc === 'https://x.com/de/ueber-uns')!
    expect(de.alternates).toEqual(en.alternates)
    expect(de.lastmod).toBe('L1')
  })

  it('adds no alternates for a single-variant group', () => {
    const entries = withHreflang([{ loc: 'https://x.com/about', locale: 'en', group: 'g1' }], 'en')
    expect(entries[0].alternates).toBeUndefined()
  })

  it('adds no alternates for rows without a translation group', () => {
    const entries = withHreflang(
      [
        { loc: 'https://x.com/a', locale: 'en', group: null },
        { loc: 'https://x.com/b', locale: 'en', group: undefined },
      ],
      'en',
    )
    expect(entries.every((e) => e.alternates === undefined)).toBe(true)
  })

  it('omits x-default when the primary-locale variant is absent from the group', () => {
    const entries = withHreflang(
      [
        { loc: 'https://x.com/de/a', locale: 'de', group: 'g1' },
        { loc: 'https://x.com/fr/a', locale: 'fr', group: 'g1' },
      ],
      'en',
    )
    const alts = entries[0].alternates!
    expect(alts.map((a) => a.hreflang)).toEqual(['de', 'fr'])
  })
})

describe('buildRobots', () => {
  it('allows all and omits the Sitemap line when no url is given', () => {
    expect(buildRobots()).toBe('User-agent: *\nAllow: /\n')
  })

  it('appends a Sitemap directive when a url is given', () => {
    expect(buildRobots({ sitemapUrl: 'https://x.com/sitemap.xml' })).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://x.com/sitemap.xml\n',
    )
  })

  it('points AI agents at llms.txt via a comment line, above the Sitemap directive', () => {
    expect(buildRobots({ sitemapUrl: 'https://x.com/sitemap.xml', llmsUrl: 'https://x.com/llms.txt' })).toBe(
      'User-agent: *\nAllow: /\n# llms.txt: https://x.com/llms.txt\n\nSitemap: https://x.com/sitemap.xml\n',
    )
    // llms-only (no sitemap) still works
    expect(buildRobots({ llmsUrl: 'https://x.com/llms.txt' })).toBe('User-agent: *\nAllow: /\n# llms.txt: https://x.com/llms.txt\n')
  })
})
