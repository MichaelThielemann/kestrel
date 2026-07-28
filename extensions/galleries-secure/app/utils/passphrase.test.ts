import { describe, it, expect } from 'vitest'
import { generatePassphrase, randomIndex, passphraseEntropyBits, estimatePasswordBits, MIN_PASSWORD_BITS } from './passphrase'
import { WORDLIST_DE } from './wordlist.de'

describe('passphrase generator', () => {
  it('produces the requested number of words joined by the separator', () => {
    const p = generatePassphrase()
    expect(p.split('-')).toHaveLength(10) // default 10 words, "-" separator
    expect(generatePassphrase({ words: 4, separator: '.' }).split('.')).toHaveLength(4)
  })

  it('the default suggestion clears the diceware-grade entropy bar for world-readable ciphertext', () => {
    // The gallery ciphertext is permanently public, so the passphrase is the ONLY barrier to offline
    // brute force. The default suggestion must comfortably exceed both the acceptance floor and the
    // ~78-bit EFF-diceware norm (10 words × log2(296) ≈ 82 bits).
    const words = generatePassphrase().split('-').length
    expect(passphraseEntropyBits(words, WORDLIST_DE.length)).toBeGreaterThanOrEqual(78)
    expect(passphraseEntropyBits(words, WORDLIST_DE.length)).toBeGreaterThan(MIN_PASSWORD_BITS)
  })

  it('draws only from the word list', () => {
    const set = new Set(WORDLIST_DE)
    for (const w of generatePassphrase({ words: 30 }).split('-')) expect(set.has(w)).toBe(true)
  })

  it('is random — many runs yield many distinct passphrases', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassphrase()))
    expect(seen.size).toBeGreaterThan(190) // essentially all unique
  })

  it('randomIndex stays in range and covers a spread', () => {
    const counts = new Array(10).fill(0)
    for (let i = 0; i < 2000; i++) {
      const idx = randomIndex(10)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(10)
      counts[idx]++
    }
    expect(counts.every((c) => c > 0)).toBe(true) // every bucket hit (no obvious bias/gap)
  })

  it('randomIndex rejects an empty list', () => {
    expect(() => randomIndex(0)).toThrow()
  })

  it('reports entropy and the default carries a sane amount', () => {
    expect(passphraseEntropyBits(6, 256)).toBeCloseTo(48, 0)
    expect(passphraseEntropyBits(6, WORDLIST_DE.length)).toBeGreaterThan(45)
  })
})

describe('estimatePasswordBits — user-typed password floor', () => {
  it('returns 0 for empty', () => {
    expect(estimatePasswordBits('')).toBe(0)
  })
  it('the acceptance floor is raised for permanently-public offline-attackable ciphertext', () => {
    expect(MIN_PASSWORD_BITS).toBeGreaterThanOrEqual(70)
  })
  it('flags a short single-class password as below the floor', () => {
    expect(estimatePasswordBits('password')).toBeLessThan(MIN_PASSWORD_BITS) // 8 lowercase ≈ 37.6 bits
    expect(estimatePasswordBits('aaaaaaaa')).toBeLessThan(MIN_PASSWORD_BITS)
  })
  it('flags a long but low-variety / repeated password despite raw length × charset clearing the floor', () => {
    expect(estimatePasswordBits('a'.repeat(15))).toBeLessThan(MIN_PASSWORD_BITS) // raw model scores 70.5
    expect(estimatePasswordBits('passwordpassword')).toBeLessThan(MIN_PASSWORD_BITS) // raw model scores 75.2
  })
  it('passes a longer / mixed-class password and the generated passphrase', () => {
    expect(estimatePasswordBits('Tr0ub4dour&3xpand')).toBeGreaterThanOrEqual(MIN_PASSWORD_BITS)
    expect(estimatePasswordBits('correcthorsebatterystaple')).toBeGreaterThanOrEqual(MIN_PASSWORD_BITS)
    expect(estimatePasswordBits(generatePassphrase())).toBeGreaterThan(MIN_PASSWORD_BITS)
  })
})

describe('WORDLIST_DE integrity', () => {
  it('is large enough for useful entropy', () => {
    expect(WORDLIST_DE.length).toBeGreaterThanOrEqual(256)
  })
  it('has no duplicates', () => {
    expect(new Set(WORDLIST_DE).size).toBe(WORDLIST_DE.length)
  })
  it('every word is lowercase and free of separators/spaces/umlauts', () => {
    for (const w of WORDLIST_DE) {
      expect(w).toBe(w.toLowerCase())
      expect(w).toMatch(/^[a-z]+$/) // transliterated: a–z only (no "-", space, ä/ö/ü/ß)
    }
  })
})
