import { describe, it, expect } from 'vitest'
import { coerceFilterValue } from './filter-predicate'

// A minimal stand-in for the bits of a Drizzle column that coerceFilterValue inspects.
const col = (sqlType: string, mode?: string) => ({ getSQLType: () => sqlType, mode })

describe('coerceFilterValue — keyed on column storage (works for builtin AND custom field types)', () => {
  it('boolean-mode column: stringified bool → real bool (incl. the "false" → 1 footgun)', () => {
    expect(coerceFilterValue(col('integer', 'boolean'), 'false')).toBe(false)
    expect(coerceFilterValue(col('integer', 'boolean'), 'true')).toBe(true)
    expect(coerceFilterValue(col('integer', 'boolean'), '1')).toBe(true)
    expect(coerceFilterValue(col('integer', 'boolean'), '0')).toBe(false)
  })
  it('integer / real column: numeric string → number; non-numeric passes through', () => {
    expect(coerceFilterValue(col('integer'), '5')).toBe(5)
    expect(coerceFilterValue(col('real'), '1.5')).toBe(1.5)
    expect(coerceFilterValue(col('integer'), 'x')).toBe('x')
  })
  it('text column: passthrough (e.g. a custom color filter)', () => {
    expect(coerceFilterValue(col('text'), '#aabbcc')).toBe('#aabbcc')
  })
  it('timestamp column: parses a date value to a Date (drizzle maps via getTime, not a raw string → 500)', () => {
    const out = coerceFilterValue(col('integer', 'timestamp'), '2026-01-02T00:00:00.000Z')
    expect(out).toBeInstanceOf(Date)
    expect((out as Date).toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(coerceFilterValue(col('integer', 'timestamp'), 1_700_000_000_000)).toBeInstanceOf(Date)
  })
  it('timestamp column: an unparseable value is a clean 400, not a query-time crash', () => {
    expect(() => coerceFilterValue(col('integer', 'timestamp'), 'not-a-date')).toThrowError(/Invalid timestamp filter/)
  })
})
