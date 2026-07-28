import { describe, it, expect } from 'vitest'
import { parseId } from './http'

describe('parseId', () => {
  it('accepts canonical positive integers', () => {
    expect(parseId('1')).toBe(1)
    expect(parseId('42')).toBe(42)
  })
  it('rejects non-canonical / non-positive-integer ids', () => {
    for (const bad of ['', '0', '007', '0x10', '1e3', ' 5 ', 'abc', '-1', '1.5']) {
      expect(() => parseId(bad)).toThrowError(/Invalid id/)
    }
  })
})
