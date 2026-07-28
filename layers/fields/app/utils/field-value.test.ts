import { describe, it, expect } from 'vitest'
import { tryParseJson } from './field-value'

describe('tryParseJson', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(tryParseJson('[1,2]')).toEqual({ ok: true, value: [1, 2] })
  })
  it('reports failure on invalid JSON', () => {
    expect(tryParseJson('{bad')).toEqual({ ok: false })
    expect(tryParseJson('')).toEqual({ ok: false })
  })
})
