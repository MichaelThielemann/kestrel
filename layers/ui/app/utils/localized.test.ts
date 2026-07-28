import { describe, it, expect } from 'vitest'
import { resolveLocalized } from './localized'

describe('resolveLocalized', () => {
  it('returns a plain string unchanged (language-agnostic label)', () => {
    expect(resolveLocalized('Page', 'de')).toBe('Page')
    expect(resolveLocalized('Page', 'en')).toBe('Page')
  })

  it('resolves a localized map to the active admin language', () => {
    expect(resolveLocalized({ en: 'Page', de: 'Seite' }, 'de')).toBe('Seite')
    expect(resolveLocalized({ en: 'Page', de: 'Seite' }, 'en')).toBe('Page')
  })

  it('falls back to en, then any present value, for a language with no entry', () => {
    expect(resolveLocalized({ en: 'Page', de: 'Seite' }, 'fr')).toBe('Page')
    expect(resolveLocalized({ de: 'Seite' }, 'fr')).toBe('Seite')
  })

  it('returns undefined for an absent value so callers can fall back (e.g. to the name)', () => {
    expect(resolveLocalized(undefined, 'de')).toBeUndefined()
  })
})
