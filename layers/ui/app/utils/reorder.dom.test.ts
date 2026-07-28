import { describe, it, expect } from 'vitest'
import { reorder } from './reorder'

describe('reorder', () => {
  it('moves an item within bounds', () => {
    expect(reorder([1, 2, 3], 0, 1)).toEqual([2, 1, 3])
  })

  it('moves an item to the start', () => {
    expect(reorder([1, 2, 3], 2, 0)).toEqual([3, 1, 2])
  })

  it('moves an item to the end', () => {
    expect(reorder([1, 2, 3], 0, 2)).toEqual([2, 3, 1])
  })

  it('returns unchanged copy when from === to', () => {
    const arr = [1, 2, 3]
    const result = reorder(arr, 1, 1)
    expect(result).toEqual([1, 2, 3])
    expect(result).not.toBe(arr)
  })

  it('returns unchanged copy when from is out of range', () => {
    const arr = [1, 2, 3]
    const result = reorder(arr, -1, 1)
    expect(result).toEqual([1, 2, 3])
    expect(result).not.toBe(arr)
  })

  it('returns unchanged copy when to is out of range', () => {
    const arr = [1, 2, 3]
    const result = reorder(arr, 0, 5)
    expect(result).toEqual([1, 2, 3])
    expect(result).not.toBe(arr)
  })
})
