import { describe, it, expect } from 'vitest'
import { numberIsInteger, choiceValues } from './field-constraints'

describe('numberIsInteger', () => {
  it('is true by default (no/empty options)', () => {
    expect(numberIsInteger(undefined)).toBe(true)
    expect(numberIsInteger({})).toBe(true)
  })

  it('is true when integer is explicitly true', () => {
    expect(numberIsInteger({ integer: true })).toBe(true)
  })

  it('is false when integer is explicitly false', () => {
    expect(numberIsInteger({ integer: false })).toBe(false)
  })

  it('is false when a decimals precision is set (even decimals: 0)', () => {
    expect(numberIsInteger({ decimals: 2 })).toBe(false)
    expect(numberIsInteger({ decimals: 0 })).toBe(false)
  })
})

describe('choiceValues', () => {
  it('maps the choices to their values', () => {
    const choices = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]
    expect(choiceValues({ choices })).toEqual(['a', 'b'])
  })
})
