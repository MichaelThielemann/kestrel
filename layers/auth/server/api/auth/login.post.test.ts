import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createError } from 'h3'
import { throttleKey } from '../../utils/client-ip'
import {
  assertBodyLimit, reserveLoginAttempt, releaseLoginAttempt, clearLoginFailures,
  acquireHashSlot, releaseHashSlot, clearAllLoginFailures, loginFailIpCount, MAX_LOGIN_FAILS,
  MAX_INFLIGHT_HASHES,
} from '../../utils/login-throttle'
import { requireAdminHash } from '../../utils/admin-credential'

interface FakeEvent { headers?: Record<string, string>; body?: unknown; ip?: string }

let verifyOk: boolean
let setAuthCalls: number

// The handler is a Nitro route: its auto-imported helpers are plain globals in a node test. verifyPassword
// and setAuthSession are stubbed (their own correctness is covered by password.test.ts /
// session-cookie.test.ts) — everything else is the real production module.
Object.assign(globalThis, {
  defineEventHandler: (h: unknown) => h,
  getRequestHeader: (event: FakeEvent, name: string) => event.headers?.[name],
  readBody: async (event: FakeEvent) => event.body ?? {},
  createError,
  clientIp: (event: FakeEvent) => event.ip ?? '203.0.113.9',
  throttleKey,
  assertBodyLimit,
  reserveLoginAttempt,
  releaseLoginAttempt,
  clearLoginFailures,
  acquireHashSlot,
  releaseHashSlot,
  requireAdminHash,
  verifyPassword: async () => verifyOk,
  setAuthSession: () => { setAuthCalls++; return 123 },
})

const handler = (await import('./login.post')).default as unknown as (event: FakeEvent) => Promise<unknown>

const ORIG = { ...process.env }
const ev = (over: Partial<FakeEvent> = {}): FakeEvent =>
  ({ headers: { 'content-length': '20' }, body: { password: 'x' }, ...over })

beforeEach(() => {
  process.env = { ...ORIG, KESTREL_ADMIN_PASSWORD_HASH: 'scrypt$1$1$1$aa$bb' }
  clearAllLoginFailures()
  verifyOk = false
  setAuthCalls = 0
})
afterEach(() => { process.env = { ...ORIG }; clearAllLoginFailures() })

describe('POST /api/auth/login', () => {
  it('records a genuine failed credential check', async () => {
    await expect(handler(ev())).rejects.toMatchObject({ statusCode: 401 })
    expect(loginFailIpCount()).toBe(1)
  })

  it('a successful login clears the recorded failures and sets the session', async () => {
    verifyOk = true
    await expect(handler(ev())).resolves.toMatchObject({ ok: true })
    expect(setAuthCalls).toBe(1)
    expect(loginFailIpCount()).toBe(0)
  })

  it('does not burn the throttle budget when no admin hash is configured (login is impossible for everyone)', async () => {
    delete process.env.KESTREL_ADMIN_PASSWORD_HASH
    await expect(handler(ev())).rejects.toMatchObject({ statusCode: 503 })
    expect(loginFailIpCount()).toBe(0)
  })

  it('still charges an attempt when the hash slots are saturated, so a slot-busy flood self-limits', async () => {
    // Saturating the slots is attacker-triggerable, so the resulting 503 must stay billable: a refund here
    // would let one key hold the slots busy forever without ever reaching the lockout.
    for (let i = 0; i < MAX_INFLIGHT_HASHES; i++) acquireHashSlot()
    try {
      for (let i = 0; i < MAX_LOGIN_FAILS; i++) {
        await expect(handler(ev())).rejects.toMatchObject({ statusCode: 503 })
      }
      expect(loginFailIpCount()).toBe(1)
      // budget spent: the throttle now refuses before the slot cap is even consulted
      await expect(handler(ev())).rejects.toMatchObject({ statusCode: 429 })
    } finally {
      for (let i = 0; i < MAX_INFLIGHT_HASHES; i++) releaseHashSlot()
    }
  })

  it('a spray across distinct source addresses in the same routed IPv6 /64 shares one throttle budget', async () => {
    const addr = (i: number) => `2001:db8:aaaa:1::${(i + 1).toString(16)}`
    for (let i = 0; i < MAX_LOGIN_FAILS; i++) {
      await expect(handler(ev({ ip: addr(i) }))).rejects.toMatchObject({ statusCode: 401 })
    }
    await expect(handler(ev({ ip: addr(MAX_LOGIN_FAILS) }))).rejects.toMatchObject({ statusCode: 429 })
  })
})
