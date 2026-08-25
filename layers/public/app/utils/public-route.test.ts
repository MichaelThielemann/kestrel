import { describe, it, expect } from 'vitest'
import { resolvePublicRoute, pickPublicLocales } from './public-route'

describe('resolvePublicRoute — locale + lookup path from URL segments (mirrors the server routing)', () => {
  it('primary locale is unprefixed; the path is the full segment list', () => {
    expect(resolvePublicRoute(['about'], ['en', 'de'], 'en')).toEqual({ locale: 'en', path: '/about' })
    expect(resolvePublicRoute([], ['en', 'de'], 'en')).toEqual({ locale: 'en', path: '/' })
  })

  it('a configured non-primary locale prefix is stripped and selected', () => {
    expect(resolvePublicRoute(['de', 'ueber'], ['en', 'de'], 'en')).toEqual({ locale: 'de', path: '/ueber' })
    expect(resolvePublicRoute(['de'], ['en', 'de'], 'en')).toEqual({ locale: 'de', path: '/' })
  })

  it('works for an arbitrary locale set — the bug was en/de hardcoded', () => {
    expect(resolvePublicRoute(['fr', 'about'], ['en', 'fr'], 'en')).toEqual({ locale: 'fr', path: '/about' })
    // a non-en primary: unprefixed is the primary (de); /en/ is the prefixed secondary
    expect(resolvePublicRoute(['about'], ['de', 'en'], 'de')).toEqual({ locale: 'de', path: '/about' })
    expect(resolvePublicRoute(['en', 'about'], ['de', 'en'], 'de')).toEqual({ locale: 'en', path: '/about' })
  })

  it('an unknown leading segment is part of the path, not a locale', () => {
    expect(resolvePublicRoute(['frabjous'], ['en', 'fr'], 'en')).toEqual({ locale: 'en', path: '/frabjous' })
    // the primary as a prefix is NOT stripped (canonical primary is unprefixed) -> a literal path
    expect(resolvePublicRoute(['en', 'about'], ['en', 'fr'], 'en')).toEqual({ locale: 'en', path: '/en/about' })
  })

  it('lowercases the path and trims trailing slashes', () => {
    expect(resolvePublicRoute(['FR', 'About', 'Us', ''], ['en', 'fr'], 'en')).toEqual({ locale: 'fr', path: '/about/us' })
  })

  it('with prefixPrimary, the primary locale prefix is stripped too', () => {
    // /en/about → en page /about (under prefixPrimary the primary IS prefixed)
    expect(resolvePublicRoute(['en', 'about'], ['en', 'de'], 'en', true)).toEqual({ locale: 'en', path: '/about' })
    expect(resolvePublicRoute(['en'], ['en', 'de'], 'en', true)).toEqual({ locale: 'en', path: '/' })
    expect(resolvePublicRoute(['de', 'ueber'], ['en', 'de'], 'en', true)).toEqual({ locale: 'de', path: '/ueber' })
    // a bare path with no locale segment falls back to the primary (a soft live alias; not generated statically)
    expect(resolvePublicRoute(['about'], ['en', 'de'], 'en', true)).toEqual({ locale: 'en', path: '/about' })
    expect(resolvePublicRoute([], ['en', 'de'], 'en', true)).toEqual({ locale: 'en', path: '/' })
  })
})

describe('pickPublicLocales — content locales from a runtimeConfig.public-shaped object (public-layer, no admin dep)', () => {
  it('reads a valid multi-locale config verbatim', () => {
    expect(pickPublicLocales({ locales: ['en', 'de'], primaryLocale: 'en' })).toEqual({
      locales: ['en', 'de'],
      primary: 'en',
      prefixPrimary: false,
    })
  })

  it('falls back to [en] when locales is absent, empty, or not an array', () => {
    expect(pickPublicLocales({})).toEqual({ locales: ['en'], primary: 'en', prefixPrimary: false })
    expect(pickPublicLocales({ locales: [] })).toEqual({ locales: ['en'], primary: 'en', prefixPrimary: false })
    expect(pickPublicLocales({ locales: 'de' })).toEqual({ locales: ['en'], primary: 'en', prefixPrimary: false })
  })

  it('falls back the primary to the first locale when the configured primary is not in the set', () => {
    expect(pickPublicLocales({ locales: ['de', 'en'], primaryLocale: 'fr' })).toEqual({
      locales: ['de', 'en'],
      primary: 'de',
      prefixPrimary: false,
    })
    expect(pickPublicLocales({ locales: ['de', 'en'] })).toEqual({ locales: ['de', 'en'], primary: 'de', prefixPrimary: false })
  })

  it('coerces locale entries to strings and passes prefixPrimary through only when strictly true', () => {
    expect(pickPublicLocales({ locales: [1, 2], primaryLocale: '1', prefixPrimary: true })).toEqual({
      locales: ['1', '2'],
      primary: '1',
      prefixPrimary: true,
    })
    expect(pickPublicLocales({ locales: ['en'], prefixPrimary: 'yes' }).prefixPrimary).toBe(false)
  })
})
