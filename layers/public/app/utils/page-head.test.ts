import { describe, it, expect } from 'vitest'
import { buildPageHead } from './page-head'

const base = {
  siteUrl: 'https://example.com/',
  siteName: 'Example',
  path: '/about',
  locale: 'en',
  primary: 'en',
  prefixPrimary: false,
  title: 'About us',
  description: 'Who we are',
}

describe('buildPageHead', () => {
  it('emits canonical + OG + twitter card from the site url and page meta', () => {
    const h = buildPageHead(base)
    expect(h.canonical).toBe('https://example.com/about')
    expect(h.meta.ogTitle).toBe('About us')
    expect(h.meta.ogDescription).toBe('Who we are')
    expect(h.meta.ogUrl).toBe('https://example.com/about')
    expect(h.meta.ogType).toBe('website')
    expect(h.meta.ogSiteName).toBe('Example')
    expect(h.meta.twitterCard).toBe('summary')
    expect(h.meta.ogImage).toBeUndefined()
  })

  it('locale-prefixes the canonical for a non-primary locale', () => {
    const h = buildPageHead({ ...base, locale: 'de', path: '/ueber-uns' })
    expect(h.canonical).toBe('https://example.com/de/ueber-uns')
    expect(h.meta.ogUrl).toBe('https://example.com/de/ueber-uns')
  })

  it('adds og:image (absolute) + dimensions and upgrades the twitter card when an image is set', () => {
    const h = buildPageHead({ ...base, image: { src: '/uploads/a/hero.webp', width: 1280, height: 720 } })
    expect(h.meta.ogImage).toBe('https://example.com/uploads/a/hero.webp')
    expect(h.meta.ogImageWidth).toBe(1280)
    expect(h.meta.ogImageHeight).toBe(720)
    expect(h.meta.twitterCard).toBe('summary_large_image')
  })

  it('keeps an already-absolute image src (e.g. S3/CDN media base) as-is', () => {
    const h = buildPageHead({ ...base, image: { src: 'https://cdn.example.net/hero.webp' } })
    expect(h.meta.ogImage).toBe('https://cdn.example.net/hero.webp')
  })

  it('emits hreflang alternates (locale-prefixed, absolute) + x-default at the primary variant', () => {
    const h = buildPageHead({
      ...base,
      alternates: [
        { locale: 'de', path: '/ueber-uns' },
        { locale: 'en', path: '/about' },
      ],
    })
    expect(h.links).toEqual([
      { rel: 'alternate', hreflang: 'de', href: 'https://example.com/de/ueber-uns' },
      { rel: 'alternate', hreflang: 'en', href: 'https://example.com/about' },
      { rel: 'alternate', hreflang: 'x-default', href: 'https://example.com/about' },
    ])
  })

  it('omits x-default when the primary-locale variant is not published', () => {
    const h = buildPageHead({
      ...base,
      locale: 'de',
      path: '/ueber-uns',
      alternates: [
        { locale: 'de', path: '/ueber-uns' },
        { locale: 'fr', path: '/a-propos' },
      ],
    })
    expect(h.links.some((l) => l.hreflang === 'x-default')).toBe(false)
    expect(h.links).toHaveLength(2)
  })

  it('degrades without a siteUrl: no canonical, no hreflang, no og:url/og:image — text OG tags remain', () => {
    const h = buildPageHead({ ...base, siteUrl: '', image: { src: '/uploads/a/hero.webp' }, alternates: [{ locale: 'de', path: '/u' }, { locale: 'en', path: '/about' }] })
    expect(h.canonical).toBeUndefined()
    expect(h.links).toEqual([])
    expect(h.meta.ogUrl).toBeUndefined()
    expect(h.meta.ogImage).toBeUndefined()
    expect(h.meta.ogTitle).toBe('About us')
    expect(h.meta.twitterCard).toBe('summary')
  })

  it('still emits an absolute og:image without a siteUrl when the media src itself is absolute', () => {
    const h = buildPageHead({ ...base, siteUrl: '', image: { src: 'https://cdn.example.net/x.webp' } })
    expect(h.meta.ogImage).toBe('https://cdn.example.net/x.webp')
    expect(h.meta.twitterCard).toBe('summary_large_image')
  })

  it('omits og:title/og:description when the page has none (no empty tags)', () => {
    const h = buildPageHead({ ...base, title: undefined, description: undefined, siteName: undefined })
    expect(h.meta.ogTitle).toBeUndefined()
    expect(h.meta.ogDescription).toBeUndefined()
    expect(h.meta.ogSiteName).toBeUndefined()
  })
})
