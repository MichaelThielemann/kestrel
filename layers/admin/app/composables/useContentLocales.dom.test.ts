import { describe, it, expect } from 'vitest'
import { pickContentLocales } from './useContentLocales'

describe('pickContentLocales', () => {
  it('reads the configured website locales + primary from runtime config', () => {
    expect(pickContentLocales({ locales: ['en', 'de'], primaryLocale: 'en' })).toEqual({ locales: ['en', 'de'], primary: 'en', prefixPrimary: false })
  })

  it('falls back to the first locale when the configured primary is absent/invalid', () => {
    expect(pickContentLocales({ locales: ['de', 'fr'], primaryLocale: 'en' })).toEqual({ locales: ['de', 'fr'], primary: 'de', prefixPrimary: false })
    expect(pickContentLocales({ locales: ['de', 'fr'] })).toEqual({ locales: ['de', 'fr'], primary: 'de', prefixPrimary: false })
  })

  it("defaults to ['en'] when no locales are configured", () => {
    expect(pickContentLocales({})).toEqual({ locales: ['en'], primary: 'en', prefixPrimary: false })
    expect(pickContentLocales({ locales: [] })).toEqual({ locales: ['en'], primary: 'en', prefixPrimary: false })
  })

  it('reflects prefixPrimary from the config (default false; only true === true)', () => {
    expect(pickContentLocales({ locales: ['en'], primaryLocale: 'en', prefixPrimary: true }).prefixPrimary).toBe(true)
    expect(pickContentLocales({ locales: ['en'], primaryLocale: 'en', prefixPrimary: 'yes' as unknown }).prefixPrimary).toBe(false)
  })
})
