import { describe, it, expect } from 'vitest'
import { primaryLocale, supportedLocales, isSupportedLocale, resolveLocale } from './locale'

describe('locale', () => {
  it('defaults en as primary and [en, de] as supported (no runtimeConfig / KESTREL_LOCALES)', () => {
    expect(primaryLocale()).toBe('en')
    expect([...supportedLocales()]).toEqual(['en', 'de'])
  })

  it('isSupportedLocale is case-insensitive after normalisation', () => {
    expect(isSupportedLocale('de')).toBe(true)
    expect(isSupportedLocale('fr')).toBe(false)
  })

  it('resolveLocale defaults to primary when empty', () => {
    expect(resolveLocale(undefined)).toBe('en')
    expect(resolveLocale('')).toBe('en')
  })

  it('resolveLocale lowercases and trims supported locales', () => {
    expect(resolveLocale(' DE ')).toBe('de')
  })

  it('resolveLocale throws 400 on unsupported locale', () => {
    expect(() => resolveLocale('fr')).toThrowError(/Unsupported locale/)
  })
})
