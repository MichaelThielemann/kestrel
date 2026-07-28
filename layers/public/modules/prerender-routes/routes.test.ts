import { describe, it, expect } from 'vitest'
import { pagesToRoutes } from './routes'

describe('pagesToRoutes', () => {
  it('maps published pages to URLs (primary unprefixed, others locale-prefixed)', () => {
    const rows = [
      { path: '/', locale: 'en' },
      { path: '/about', locale: 'en' },
      { path: '/ueber', locale: 'de' },
      { path: '/', locale: 'de' },
    ]
    expect(pagesToRoutes(rows, 'en')).toEqual(['/', '/about', '/de', '/de/ueber'])
  })

  it('always includes the root and dedupes/sorts', () => {
    expect(pagesToRoutes([], 'en')).toEqual(['/'])
    expect(pagesToRoutes([{ path: '/about', locale: 'en' }, { path: '/about', locale: 'en' }], 'en')).toEqual(['/', '/about'])
  })

  it('skips rows with a null path and normalizes a missing leading slash', () => {
    const rows = [{ path: null, locale: 'en' }, { path: 'blog', locale: 'en' }]
    expect(pagesToRoutes(rows, 'en')).toEqual(['/', '/blog'])
  })

  it('with prefixPrimary, the site root and primary pages are prefixed too', () => {
    const rows = [{ path: '/', locale: 'en' }, { path: '/about', locale: 'en' }, { path: '/ueber', locale: 'de' }]
    expect(pagesToRoutes(rows, 'en', true)).toEqual(['/de/ueber', '/en', '/en/about'])
  })
})
