import { describe, it, expect } from 'vitest'
import { localePath } from '../../../src/app/utils/locale-path.js'

describe('localePath', () => {
  it('leaves primary-locale paths unprefixed and prefixes others', () => {
    expect(localePath('/about', 'en', 'en')).toBe('/about')
    expect(localePath('/ueber', 'de', 'en')).toBe('/de/ueber')
    expect(localePath('/', 'de', 'en')).toBe('/de')
    expect(localePath('about', 'en', 'en')).toBe('/about')
  })

  it('with prefixPrimary, prefixes the primary locale too (incl. the root)', () => {
    expect(localePath('/about', 'en', 'en', true)).toBe('/en/about')
    expect(localePath('/', 'en', 'en', true)).toBe('/en')
    expect(localePath('about', 'en', 'en', true)).toBe('/en/about')
    // non-primary locales are unaffected by the flag
    expect(localePath('/ueber', 'de', 'en', true)).toBe('/de/ueber')
    expect(localePath('/', 'de', 'en', true)).toBe('/de')
  })
})
