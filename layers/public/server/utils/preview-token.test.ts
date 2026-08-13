import { describe, it, expect } from 'vitest'
import { createPreviewStore } from './preview-token'

const payload = (over: Record<string, unknown> = {}) => ({ collection: 'pages', id: 1, values: { title: 'Draft' }, ...over })

function store(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
  let n = 0
  return createPreviewStore({ randomToken: () => `t${++n}`, ...opts })
}

describe('preview token store', () => {
  it('hands back the payload the ticket was minted with', () => {
    const s = store()
    const { token } = s.mint('admin', payload())
    expect(s.read(token, 'admin')).toEqual(payload())
  })

  it('mints a distinct token per call and reports when it expires', () => {
    let clock = 1_000
    const s = store({ ttlMs: 5_000, now: () => clock })
    const a = s.mint('admin', payload())
    const b = s.mint('admin', payload())
    expect(a.token).not.toBe(b.token)
    expect(a.expiresAt).toBe(6_000)
  })

  it('refuses a token that belongs to another session', () => {
    const s = store()
    const { token } = s.mint('admin', payload())
    expect(s.read(token, 'someone-else')).toBe(null)
  })

  it('refuses an unknown token', () => {
    expect(store().read('nope', 'admin')).toBe(null)
  })

  it('expires a ticket once its TTL has passed, and drops it', () => {
    let clock = 0
    const s = store({ ttlMs: 1_000, now: () => clock })
    const { token } = s.mint('admin', payload())
    clock = 999
    expect(s.read(token, 'admin')).not.toBe(null)
    clock = 1_001
    expect(s.read(token, 'admin')).toBe(null)
    expect(s.size()).toBe(0)
  })

  it('stays readable until it expires — a preview tab may be reloaded', () => {
    const s = store()
    const { token } = s.mint('admin', payload())
    expect(s.read(token, 'admin')).not.toBe(null)
    expect(s.read(token, 'admin')).not.toBe(null)
  })

  it('bounds itself: a new ticket evicts the oldest once the cap is reached', () => {
    const s = store({ max: 2 })
    const a = s.mint('admin', payload())
    const b = s.mint('admin', payload({ id: 2 }))
    const c = s.mint('admin', payload({ id: 3 }))
    expect(s.read(a.token, 'admin')).toBe(null)
    expect(s.read(b.token, 'admin')).not.toBe(null)
    expect(s.read(c.token, 'admin')).not.toBe(null)
    expect(s.size()).toBe(2)
  })

  it('sweeps expired tickets on mint instead of holding editor payloads forever', () => {
    let clock = 0
    const s = store({ ttlMs: 1_000, now: () => clock })
    s.mint('admin', payload())
    clock = 5_000
    s.mint('admin', payload({ id: 2 }))
    expect(s.size()).toBe(1)
  })
})
