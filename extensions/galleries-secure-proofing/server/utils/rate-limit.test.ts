import { describe, it, expect, beforeEach } from 'vitest'
import { rateLimit, clearRateLimits, rateLimitWindowCount } from './rate-limit'

describe('rateLimit — fixed window', () => {
  beforeEach(clearRateLimits)

  it('allows up to the limit, then throttles within the window', () => {
    const t = 1000
    for (let i = 0; i < 3; i++) expect(rateLimit('ip:g', t, 3, 1000)).toBe(true)
    expect(rateLimit('ip:g', t, 3, 1000)).toBe(false) // 4th in the same window
  })

  it('resets after the window elapses', () => {
    expect(rateLimit('ip:g', 1000, 1, 1000)).toBe(true)
    expect(rateLimit('ip:g', 1500, 1, 1000)).toBe(false) // still in window
    expect(rateLimit('ip:g', 2000, 1, 1000)).toBe(true) // window rolled over (now >= resetAt)
  })

  it('tracks keys independently', () => {
    expect(rateLimit('a', 1000, 1, 1000)).toBe(true)
    expect(rateLimit('a', 1000, 1, 1000)).toBe(false)
    expect(rateLimit('b', 1000, 1, 1000)).toBe(true) // different key, own budget
  })

  it('evicts expired windows so the map does not grow unbounded with rotating IPs', () => {
    for (let i = 0; i < 5; i++) rateLimit(`ip${i}`, 0, 1, 1000) // 5 windows, all resetAt = 1000
    expect(rateLimitWindowCount()).toBe(5)
    rateLimit('late', 2000, 1, 1000) // a new window created past expiry → sweeps the 5 stale entries
    expect(rateLimitWindowCount()).toBe(1) // only the live 'late' window remains
  })
})
