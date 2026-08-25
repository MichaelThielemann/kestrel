import { describe, it, expect } from 'vitest'
import { withResolveScope, memoResolver, resolveBudgetFor } from '../../../src/server/utils/resolve-scope.js'
import { memoize } from '../../../src/server/utils/prerender-memo.js'
import { captureRead, withReadCapture } from '../../../src/server/utils/read-capture.js'

describe('resolve-scope: per-request memo + fan-out budget', () => {
  it('dedupes identical resolves within one scope (a shared ref is fetched once)', () => {
    let calls = 0
    const resolve = memoResolver((id: number) => { calls++; return { id } }, (id) => String(id))
    withResolveScope(() => {
      resolve(1); resolve(1); resolve(2); resolve(1)
    })
    expect(calls).toBe(2) // ids 1 and 2 each fetched once, despite 4 calls
  })

  it('returns identical (shared) result objects for a memo hit', () => {
    const resolve = memoResolver((id: number) => ({ id }), (id) => String(id))
    let a: unknown, b: unknown
    withResolveScope(() => { a = resolve(7); b = resolve(7) })
    expect(a).toBe(b)
  })

  it('is uncached OUTSIDE a scope (a live request without population still works, no cross-request cache)', () => {
    let calls = 0
    const resolve = memoResolver((id: number) => { calls++; return { id } }, (id) => String(id))
    resolve(1); resolve(1)
    expect(calls).toBe(2)
  })

  it('nested scopes reuse the parent cache + budget (a relation getOne inherits the top-level scope)', () => {
    let calls = 0
    const resolve = memoResolver((id: number) => { calls++; return { id } }, (id) => String(id))
    withResolveScope(() => {
      resolve(1)
      withResolveScope(() => { resolve(1); resolve(2) }) // nested — no new cache
    })
    expect(calls).toBe(2)
  })

  it('caps NEW resolves at the budget, skipping over-budget ones (returns null, like a stale ref)', () => {
    let calls = 0
    const resolve = memoResolver((id: number) => { calls++; return { id } }, (id) => String(id))
    const seen: unknown[] = []
    withResolveScope(() => { for (let i = 0; i < 5; i++) seen.push(resolve(i)) }, 3)
    expect(calls).toBe(3) // only 3 distinct resolves ran
    expect(seen.slice(0, 3).every((r) => r !== null)).toBe(true)
    expect(seen.slice(3)).toEqual([null, null]) // the rest skipped
  })

  it('replays the resolver\'s captured read-tags on every memo hit — per-page publish deps stay complete', async () => {
    // a resolver that captures deps while resolving (like getOne / the media resolver do)
    const resolve = memoResolver((id: number) => { captureRead('posts', id); captureRead('media', id * 10); return { id } }, (id) => String(id))
    const pages: string[][] = []
    await withResolveScope(async () => {
      // two "pages" rendered in ONE publish run, each with its own read-capture, embedding the SAME record
      for (let p = 0; p < 2; p++) {
        const { tags } = await withReadCapture(() => { resolve(1) })
        pages.push(tags)
      }
    })
    expect(new Set(pages[0])).toEqual(new Set(['posts:1', 'media:10'])) // the miss captures directly
    expect(new Set(pages[1])).toEqual(new Set(['posts:1', 'media:10'])) // the HIT must replay, not go silent
  })

  it('a memo HIT does not consume budget (dedup is free)', () => {
    let calls = 0
    const resolve = memoResolver((id: number) => { calls++; return { id } }, (id) => String(id))
    let last: unknown
    withResolveScope(() => {
      resolve(1); resolve(1); resolve(1) // 1 new + 2 hits
      last = resolve(2) // still within budget of 2 (only 1 new resolve so far)
    }, 2)
    expect(calls).toBe(2)
    expect(last).toEqual({ id: 2 })
  })

  it('resolveBudgetFor scales with perPage above the floor', () => {
    expect(resolveBudgetFor(1)).toBe(20_000) // floor
    expect(resolveBudgetFor(25)).toBe(20_000) // still floor
    expect(resolveBudgetFor(500)).toBe(100_000) // 500 × 200
  })

  it('memoResolver OUTERMOST: a budget-skip null is NOT cached build-wide by an inner prerender memo', () => {
    // Reproduce the populator composition: memoResolver(memoDuringPrerender-equivalent(fn)). A build-wide
    // memoize sits INSIDE memoResolver, so a scope budget-skip (null) never poisons the shared cache.
    let calls = 0
    const buildWide = memoize((id: number) => { calls++; return { id } }, (id) => String(id))
    const resolve = memoResolver(buildWide, (id: number) => String(id))

    // Scope A (budget 2) resolves ids 1,2 then hits the budget on id 3 → null (scope-local skip).
    const a = withResolveScope(() => [resolve(1), resolve(2), resolve(3)], 2)
    expect(a).toEqual([{ id: 1 }, { id: 2 }, null])

    // Scope B (fresh budget) MUST get a real value for id 3 — the earlier null was never cached build-wide.
    const b = withResolveScope(() => resolve(3), 5)
    expect(b).toEqual({ id: 3 })
    expect(calls).toBe(3) // ids 1,2,3 each resolved once through the build-wide memo — no null cached
  })
})
