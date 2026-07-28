import { describe, it, expect } from 'vitest'
import { fieldConstraints } from './field-meta'

describe('fieldConstraints', () => {
  it('reports required from the field def', () => {
    expect(fieldConstraints({ type: 'text', required: true }).required).toBe(true)
    expect(fieldConstraints({ type: 'text' }).required).toBe(false)
  })

  it('derives text length bounds and multiline', () => {
    const c = fieldConstraints({ type: 'text', options: { minLength: 2, maxLength: 8, multiline: true } })
    expect(c.minlength).toBe(2)
    expect(c.maxlength).toBe(8)
    expect(c.multiline).toBe(true)
  })

  it('omits text bounds and multiline when unset', () => {
    const c = fieldConstraints({ type: 'text' })
    expect(c.minlength).toBeUndefined()
    expect(c.maxlength).toBeUndefined()
    expect(c.multiline).toBeUndefined()
  })

  it('derives number min/max and integer step', () => {
    const c = fieldConstraints({ type: 'number', options: { min: 1, max: 5 } })
    expect(c.min).toBe(1)
    expect(c.max).toBe(5)
    expect(c.step).toBe(1) // integer by default
  })

  it('uses step "any" for non-integer numbers', () => {
    expect(fieldConstraints({ type: 'number', options: { integer: false } }).step).toBe('any')
  })

  it('derives a fixed step from options.decimals', () => {
    expect(fieldConstraints({ type: 'number', options: { decimals: 2 } }).step).toBe(0.01)
    expect(fieldConstraints({ type: 'number', options: { decimals: 0 } }).step).toBe(1)
  })

  it('returns only required for types without input bounds', () => {
    expect(fieldConstraints({ type: 'json' })).toEqual({ required: false })
    expect(fieldConstraints({ type: 'boolean', required: true })).toEqual({ required: true })
  })
})
