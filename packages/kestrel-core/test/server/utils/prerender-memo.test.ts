import { describe, it, expect } from 'vitest'
import { memoize } from '../../../src/server/utils/prerender-memo.js'

describe('memoize', () => {
  it('calls the resolver once per distinct key and caches the result', () => {
    let calls = 0
    const fn = memoize((collection: string, id: number) => { calls++; return `${collection}:${id}` }, (c, id) => `${c}:${id}`)
    expect(fn('pages', 1)).toBe('pages:1')
    expect(fn('pages', 1)).toBe('pages:1')
    expect(calls).toBe(1)
    expect(fn('pages', 2)).toBe('pages:2')
    expect(calls).toBe(2)
  })

  it('caches a null/undefined result too (does not re-resolve a known miss)', () => {
    let calls = 0
    const fn = memoize((_id: number) => { calls++; return null }, (id) => String(id))
    expect(fn(7)).toBeNull()
    expect(fn(7)).toBeNull()
    expect(calls).toBe(1)
  })
})
