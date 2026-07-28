import { describe, it, expect } from 'vitest'
import { defaultToken } from './desired'

describe('defaultToken — column DEFAULT DDL tokens', () => {
  it('JSON-encodes object / array defaults (a json-backed column, e.g. a custom field type)', () => {
    expect(defaultToken({ a: 1 })).toBe(`'{"a":1}'`)
    expect(defaultToken([1, 2])).toBe(`'[1,2]'`)
    // single-quotes inside the JSON are doubled for the SQL string literal
    expect(defaultToken({ x: "it's" })).toBe(`'{"x":"it''s"}'`)
  })
  it('keeps scalar tokens unchanged', () => {
    expect(defaultToken('hi')).toBe(`'hi'`)
    expect(defaultToken(true)).toBe('1')
    expect(defaultToken(false)).toBe('0')
    expect(defaultToken(5)).toBe('5')
    expect(defaultToken(null)).toBe(null)
    expect(defaultToken(undefined)).toBe(null)
  })
})
