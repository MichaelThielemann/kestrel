import { describe, it, expect } from 'vitest'
import { slugify } from '../../../src/app/utils/slugify.js'

describe('slugify', () => {
  it('lowercases, strips diacritics, and joins words with hyphens', () => {
    expect(slugify('Über uns')).toBe('uber-uns')
    expect(slugify('Hello World')).toBe('hello-world')
    expect(slugify('Café crème')).toBe('cafe-creme')
  })

  it('collapses punctuation / symbol runs to a single hyphen and trims edges', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('  spaced   out  ')).toBe('spaced-out')
    expect(slugify('a -- b __ c')).toBe('a-b-c')
    expect(slugify('--leading and trailing--')).toBe('leading-and-trailing')
  })

  it('keeps digits and ascii letters', () => {
    expect(slugify('Top 10 Tips')).toBe('top-10-tips')
    expect(slugify('Version 2.0')).toBe('version-2-0')
  })

  it('returns empty string for blank or symbol-only input (caller must reject)', () => {
    expect(slugify('')).toBe('')
    expect(slugify('   ')).toBe('')
    expect(slugify('!!! ??? ...')).toBe('')
    expect(slugify(null as unknown as string)).toBe('')
    expect(slugify(undefined as unknown as string)).toBe('')
  })

  it('folds diacritics to ascii; letters with no ascii fold act as separators', () => {
    expect(slugify('Tür')).toBe('tur')
    expect(slugify('Niño feliz')).toBe('nino-feliz')
    // ß has no NFKD ascii fold → treated as a separator (Kestrel does no German transliteration)
    expect(slugify('Straße 7')).toBe('stra-e-7')
    // CJK has no ascii-foldable letters → empty (caller falls back to the manual slug / rejects)
    expect(slugify('日本語')).toBe('')
  })
})
