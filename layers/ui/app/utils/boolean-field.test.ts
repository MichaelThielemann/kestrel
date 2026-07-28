import { describe, it, expect } from 'vitest'
import { nextBooleanValue } from './boolean-field'

describe('nextBooleanValue', () => {
  it('maps the two explicit choices', () => {
    expect(nextBooleanValue(undefined, 'true')).toBe(true)
    expect(nextBooleanValue(undefined, 'false')).toBe(false)
    expect(nextBooleanValue(true, 'false')).toBe(false)
  })
  it('keeps the current value on a deselect (re-clicking the active option must not flip to false)', () => {
    expect(nextBooleanValue(true, null)).toBe(true)
    expect(nextBooleanValue(false, null)).toBe(false)
    expect(nextBooleanValue(undefined, null)).toBeUndefined()
  })
})
