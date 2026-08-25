import { describe, it, expect } from 'vitest'
import { PER_PAGE_OPTIONS, DEFAULT_PER_PAGE, MAX_PER_PAGE, MAX_BULK_IDS, clampPerPage } from '../../../src/app/utils/list-limits.js'

describe('list-limits — the shared page-size + bulk-id contract', () => {
  it('exposes the frozen constants', () => {
    expect(PER_PAGE_OPTIONS).toEqual([25, 50, 100, 250, 500])
    expect(DEFAULT_PER_PAGE).toBe(25)
    expect(MAX_PER_PAGE).toBe(500)
    // Derived, not guessed: a bulk op can never carry more ids than one page can display.
    expect(MAX_BULK_IDS).toBe(MAX_PER_PAGE)
  })

  describe('clampPerPage', () => {
    it('falls back to the default for a non-finite input', () => {
      expect(clampPerPage(undefined)).toBe(DEFAULT_PER_PAGE)
      expect(clampPerPage(Number.NaN)).toBe(DEFAULT_PER_PAGE)
      expect(clampPerPage(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PER_PAGE)
      expect(clampPerPage('abc')).toBe(DEFAULT_PER_PAGE)
    })

    it('floors and clamps a finite input into [1, MAX_PER_PAGE]', () => {
      expect(clampPerPage(50)).toBe(50)
      expect(clampPerPage(0)).toBe(1)
      expect(clampPerPage(-5)).toBe(1)
      expect(clampPerPage(9999)).toBe(MAX_PER_PAGE)
      expect(clampPerPage(50.9)).toBe(50)
      expect(clampPerPage('100')).toBe(100) // numeric strings (query params) coerce
    })
  })
})
