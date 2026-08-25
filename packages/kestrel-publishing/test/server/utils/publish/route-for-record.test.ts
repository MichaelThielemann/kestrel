import { describe, it, expect } from 'vitest'
import { routeForRecord } from '../../../../src/server/utils/publish/route-for-record.js'

describe('routeForRecord', () => {
  it('returns null for a non-pageLike collection', () => {
    expect(routeForRecord({ path: '/about', locale: 'en' }, false, 'en', false)).toBeNull()
  })

  it('returns null for a missing row or a blank/absent path', () => {
    expect(routeForRecord(null, true, 'en', false)).toBeNull()
    expect(routeForRecord(undefined, true, 'en', false)).toBeNull()
    expect(routeForRecord({ path: '', locale: 'en' }, true, 'en', false)).toBeNull()
    expect(routeForRecord({ locale: 'en' }, true, 'en', false)).toBeNull()
  })

  it('computes the unprefixed route for the primary locale', () => {
    expect(routeForRecord({ path: '/about', locale: 'en' }, true, 'en', false)).toBe('/about')
  })

  it('prefixes a secondary locale', () => {
    expect(routeForRecord({ path: '/about', locale: 'de' }, true, 'en', false)).toBe('/de/about')
  })

  it('falls back to the primary locale when the row carries none (non-translatable)', () => {
    expect(routeForRecord({ path: '/home' }, true, 'en', false)).toBe('/home')
  })

  it('honours prefixPrimary (root → /<primary>)', () => {
    expect(routeForRecord({ path: '/about', locale: 'en' }, true, 'en', true)).toBe('/en/about')
    expect(routeForRecord({ path: '/', locale: 'en' }, true, 'en', true)).toBe('/en')
  })
})
