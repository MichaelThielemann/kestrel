import { describe, it, expect } from 'vitest'
import { validateField } from './field-validate'

describe('validateField', () => {
  it('enforces required only when the value is empty', () => {
    expect(validateField({ type: 'text', required: true }, '')).toBeTruthy()
    expect(validateField({ type: 'text', required: true }, null)).toBeTruthy()
    expect(validateField({ type: 'text', required: true }, 'x')).toBe(null)
    expect(validateField({ type: 'text' }, '')).toBe(null)
  })

  it('treats boolean false as a present value', () => {
    expect(validateField({ type: 'boolean', required: true }, false)).toBe(null)
  })

  it('checks text length bounds', () => {
    expect(validateField({ type: 'text', options: { minLength: 3 } }, 'ab')).toBeTruthy()
    expect(validateField({ type: 'text', options: { maxLength: 3 } }, 'abcd')).toBeTruthy()
    expect(validateField({ type: 'text', options: { minLength: 1, maxLength: 3 } }, 'ab')).toBe(null)
  })

  it('checks number type, integer, and bounds', () => {
    expect(validateField({ type: 'number' }, 'nope')).toBeTruthy()
    expect(validateField({ type: 'number' }, 2.5)).toBeTruthy() // integer by default
    expect(validateField({ type: 'number', options: { integer: false } }, 2.5)).toBe(null)
    expect(validateField({ type: 'number', options: { decimals: 2 } }, 19.99)).toBe(null)
    expect(validateField({ type: 'number', options: { min: 1, max: 5 } }, 0)).toBeTruthy()
    expect(validateField({ type: 'number', options: { min: 1, max: 5 } }, 6)).toBeTruthy()
    expect(validateField({ type: 'number', options: { min: 1, max: 5 } }, 3)).toBe(null)
  })

  it('never re-parses a json field value — the widget model is always already-parsed', () => {
    // Json.vue's model holds the PARSED value, never raw text — a json field whose value happens to be a
    // plain string (e.g. `default: 'dark'`) must not be treated as unparsed JSON source and rejected.
    expect(validateField({ type: 'json' }, 'dark')).toBe(null)
    expect(validateField({ type: 'json' }, '{bad')).toBe(null) // looks like broken JSON source, but it's just a string value
    expect(validateField({ type: 'json' }, { a: 1 })).toBe(null)
    expect(validateField({ type: 'json' }, [1, 2, 3])).toBe(null)
  })

  it('checks single choice against the allowed values', () => {
    const choices = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]
    expect(validateField({ type: 'choice', options: { choices } }, 'a')).toBe(null)
    expect(validateField({ type: 'choice', options: { choices } }, 'z')).toBeTruthy()
    expect(validateField({ type: 'choice', options: { choices } }, '')).toBe(null) // not required
  })

  it('checks datetime shape per precision', () => {
    expect(validateField({ type: 'datetime', options: { precision: 'date' } }, '2024-01-15')).toBe(null)
    expect(validateField({ type: 'datetime', options: { precision: 'date' } }, '15.01.2024')).toBeTruthy()
    expect(validateField({ type: 'datetime', options: { precision: 'time' } }, '10:30')).toBe(null)
    expect(validateField({ type: 'datetime' }, '2024-01-15T10:30')).toBe(null)
  })

  it('checks datetime range order and required ends', () => {
    const range = { type: 'datetime', required: true, options: { precision: 'date', range: true } } as const
    expect(validateField(range, { start: '2024-01-01', end: '2024-01-31' })).toBe(null)
    expect(validateField(range, { start: '2024-02-01', end: '2024-01-01' })).toBeTruthy()
    expect(validateField(range, { start: '2024-01-01', end: '' })).toBeTruthy()
  })

  it('flags a half-filled range even when the field is NOT required (a picker mid-selection must not pass)', () => {
    const optionalRange = { type: 'datetime', options: { precision: 'date', range: true } } as const
    expect(validateField(optionalRange, { start: '2024-01-01', end: '' })).toBeTruthy()
    expect(validateField(optionalRange, { start: '', end: '2024-01-01' })).toBeTruthy()
    expect(validateField(optionalRange, { start: '', end: '' })).toBe(null) // fully empty, non-required: fine
    expect(validateField(optionalRange, { start: '2024-01-01', end: '2024-01-31' })).toBe(null)
  })

  it('checks multiple choice items and required-empty', () => {
    const choices = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]
    expect(validateField({ type: 'choice', required: true, options: { multiple: true, choices } }, ['a', 'b'])).toBe(null)
    expect(validateField({ type: 'choice', required: true, options: { multiple: true, choices } }, ['a', 'z'])).toBeTruthy()
    expect(validateField({ type: 'choice', required: true, options: { multiple: true, choices } }, [])).toBeTruthy()
  })
})
