import { describe, it, expect } from 'vitest'
import { isoToDate, dateToIso } from './iso-date'

describe('isoToDate', () => {
  it('parses a date string', () => {
    expect(isoToDate('2024-01-15', 'date')?.toString()).toBe('2024-01-15')
  })
  it('parses a datetime string (seconds normalized)', () => {
    expect(isoToDate('2024-01-15T10:30', 'datetime')?.toString()).toBe('2024-01-15T10:30:00')
  })
  it('returns undefined for empty, null, or invalid input', () => {
    expect(isoToDate('', 'date')).toBeUndefined()
    expect(isoToDate(null, 'date')).toBeUndefined()
    expect(isoToDate(undefined, 'datetime')).toBeUndefined()
    expect(isoToDate('not-a-date', 'date')).toBeUndefined()
  })
})

describe('dateToIso', () => {
  it('round-trips through isoToDate', () => {
    expect(dateToIso(isoToDate('2024-01-15', 'date'))).toBe('2024-01-15')
    expect(dateToIso(isoToDate('2024-01-15T10:30', 'datetime'))).toBe('2024-01-15T10:30:00')
  })
  it('returns null for null/undefined', () => {
    expect(dateToIso(null)).toBe(null)
    expect(dateToIso(undefined)).toBe(null)
  })
})
