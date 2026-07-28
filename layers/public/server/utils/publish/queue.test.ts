import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPublishQueue } from './queue'
import type { Invalidation } from './invalidation'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('createPublishQueue', () => {
  it('debounces a burst into one coalesced run', async () => {
    const calls: Invalidation[] = []
    const q = createPublishQueue({ run: async (inv) => { calls.push(inv) }, debounceMs: 100, maxWaitMs: 1000 })
    q.enqueue({ type: 'tags', tags: ['a'], render: ['/x'], prune: [] })
    q.enqueue({ type: 'tags', tags: ['b'], render: [], prune: [] })
    await vi.advanceTimersByTimeAsync(99)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    expect(calls).toEqual([{ type: 'tags', tags: ['a', 'b'], render: ['/x'], prune: [] }])
  })

  it('a full enqueue coalesces the whole batch to full', async () => {
    const calls: Invalidation[] = []
    const q = createPublishQueue({ run: async (inv) => { calls.push(inv) }, debounceMs: 10 })
    q.enqueue({ type: 'tags', tags: ['a'], render: [], prune: [] })
    q.enqueue({ type: 'full' })
    await vi.advanceTimersByTimeAsync(11)
    expect(calls).toEqual([{ type: 'full' }])
  })

  it('single-flight: enqueues during an in-flight run defer to exactly one follow-up run', async () => {
    const calls: Invalidation[] = []
    const gate = deferred()
    const q = createPublishQueue({
      run: async (inv) => { calls.push(inv); if (calls.length === 1) await gate.promise },
      debounceMs: 10,
    })
    q.enqueue({ type: 'full' })
    await vi.advanceTimersByTimeAsync(11) // first run starts, then awaits the gate
    expect(calls.length).toBe(1)
    q.enqueue({ type: 'tags', tags: ['c'], render: [], prune: [] }) // arrives mid-run
    await vi.advanceTimersByTimeAsync(20)
    expect(calls.length).toBe(1) // still one — single-flight
    gate.resolve()
    await vi.advanceTimersByTimeAsync(11) // run finishes, the deferred batch flushes
    expect(calls.length).toBe(2)
    expect(calls[1]).toEqual({ type: 'tags', tags: ['c'], render: [], prune: [] })
  })

  it('ignores noop enqueues (never runs)', async () => {
    const calls: Invalidation[] = []
    const q = createPublishQueue({ run: async (inv) => { calls.push(inv) }, debounceMs: 10 })
    q.enqueue({ type: 'noop' })
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toEqual([])
  })
})
