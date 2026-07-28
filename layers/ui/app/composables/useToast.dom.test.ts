import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createToastStore } from './useToast'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createToastStore', () => {
  it('pushes toasts with an incrementing id and the given type/message', () => {
    const t = createToastStore()
    const id1 = t.success('Saved')
    const id2 = t.error('Nope')
    expect(id2).toBe(id1 + 1)
    expect(t.items).toEqual([
      { id: id1, type: 'success', message: 'Saved' },
      { id: id2, type: 'error', message: 'Nope' },
    ])
  })

  it('dismisses by id and ignores an unknown id', () => {
    const t = createToastStore()
    const id = t.info('Hi')
    t.dismiss(9999)
    expect(t.items).toHaveLength(1)
    t.dismiss(id)
    expect(t.items).toHaveLength(0)
  })

  it('auto-expires after the timeout, but keeps a toast with timeout 0', () => {
    const t = createToastStore({ defaultTimeout: 1000 })
    t.success('bye')
    t.error('stay', 0)
    expect(t.items).toHaveLength(2)
    vi.advanceTimersByTime(1000)
    expect(t.items.map((x) => x.message)).toEqual(['stay'])
  })

  it('caps the queue at the limit, dropping the oldest', () => {
    const t = createToastStore({ limit: 2, defaultTimeout: 0 })
    t.info('a'); t.info('b'); t.info('c')
    expect(t.items.map((x) => x.message)).toEqual(['b', 'c'])
  })
})
