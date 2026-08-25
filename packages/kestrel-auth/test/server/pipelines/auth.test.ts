import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { clearPipelines, registerPipeline } from '@kestrel/core'
import { runPipelineForEventAsync, runPipelineForEvent } from '@kestrel/access'
import {
  clearAllLoginFailures, loginFailIpCount, acquireHashSlot, releaseHashSlot,
  MAX_LOGIN_FAILS, MAX_INFLIGHT_HASHES,
} from '../../../src/server/utils/login-throttle.js'
import { buildAuthPipelines } from '../../../src/server/pipelines/auth.js'

// The password hash and the session cookie have their own suites (password.test.ts / session-cookie.test.ts);
// everything else in the chain — throttle, credential lookup, gates — is the real production module.
let verifyOk = false
let verifyRejects = false
let setAuthCalls = 0
let clearCalls = 0
let bumpCalls = 0

vi.mock('../../../src/server/utils/password.js', () => ({
  verifyPassword: async () => {
    if (verifyRejects) throw new Error('scrypt exploded')
    return verifyOk
  },
}))
vi.mock('../../../src/server/utils/session-cookie.js', () => ({
  setAuthSession: () => { setAuthCalls++; return 123 },
  clearAuthSession: () => { clearCalls++ },
}))
vi.mock('../../../src/server/utils/session-epoch.js', () => ({ bumpSessionEpoch: () => { bumpCalls++ } }))

const ORIG = { ...process.env }

function eventFor(method: string, options: { ip?: string, body?: unknown, role?: string } = {}): H3Event {
  const body = JSON.stringify(options.body ?? { password: 'x' })
  const event = createEvent(
    {
      method,
      url: '/api/auth',
      headers: { 'sec-fetch-site': 'same-origin', 'content-length': String(body.length), 'content-type': 'application/json' },
      socket: { remoteAddress: options.ip ?? '203.0.113.9' },
    } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId: options.role === 'admin' ? 'admin' : null, role: options.role ?? 'anonymous' } as never
  // The mocked request is not a readable stream, so hand `readBody` the raw payload directly.
  ;(event as unknown as { _requestBody: string })._requestBody = body
  return event
}

const login = (options: Parameters<typeof eventFor>[1] = {}) =>
  runPipelineForEventAsync(eventFor('POST', options), { op: 'login' })
const logout = (role?: string) => runPipelineForEvent(eventFor('POST', { role }), { op: 'logout' })

beforeEach(() => {
  process.env = { ...ORIG, KESTREL_ADMIN_PASSWORD_HASH: 'scrypt$1$1$1$aa$bb' }
  clearPipelines()
  for (const def of buildAuthPipelines()) registerPipeline(def)
  clearAllLoginFailures()
  verifyOk = false
  verifyRejects = false
  setAuthCalls = 0
  clearCalls = 0
  bumpCalls = 0
})
afterEach(() => { process.env = { ...ORIG }; clearAllLoginFailures(); clearPipelines() })

describe('login pipeline', () => {
  it('records a genuine failed credential check', async () => {
    await expect(login()).rejects.toMatchObject({ _tag: 'Unauthorized' })
    expect(loginFailIpCount()).toBe(1)
  })

  it('a successful login clears the recorded failures and sets the session', async () => {
    verifyOk = true
    await expect(login()).resolves.toMatchObject({ ok: true })
    expect(setAuthCalls).toBe(1)
    expect(loginFailIpCount()).toBe(0)
  })

  it('does not burn the throttle budget when no admin hash is configured (login is impossible for everyone)', async () => {
    delete process.env.KESTREL_ADMIN_PASSWORD_HASH
    await expect(login()).rejects.toMatchObject({ statusCode: 503 })
    expect(loginFailIpCount()).toBe(0)
  })

  it('still charges an attempt when the hash slots are saturated, so a slot-busy flood self-limits', async () => {
    // Saturating the slots is attacker-triggerable, so the resulting 503 must stay billable: a refund here
    // would let one key hold the slots busy forever without ever reaching the lockout.
    for (let i = 0; i < MAX_INFLIGHT_HASHES; i++) acquireHashSlot()
    try {
      for (let i = 0; i < MAX_LOGIN_FAILS; i++) {
        await expect(login()).rejects.toMatchObject({ statusCode: 503 })
      }
      expect(loginFailIpCount()).toBe(1)
      // budget spent: the throttle now refuses before the slot cap is even consulted
      await expect(login()).rejects.toMatchObject({ statusCode: 429 })
    } finally {
      for (let i = 0; i < MAX_INFLIGHT_HASHES; i++) releaseHashSlot()
    }
  })

  it('releases the hash slot when verifyPassword rejects mid-check (not just when it resolves false)', async () => {
    // A rejection crosses the yield* as a defect, not a failure value — this is exactly the shape
    // `Effect.ensuring` (not a plain try/finally) is required to observe. Running MAX_INFLIGHT_HASHES
    // rejecting logins and then one more proves every slot was actually released: if it weren't, the
    // slots would stay saturated and the next login would hit the 503 busy path instead of the real
    // credential check.
    verifyRejects = true
    for (let i = 0; i < MAX_INFLIGHT_HASHES; i++) {
      await expect(login()).rejects.toThrow('scrypt exploded')
    }
    verifyRejects = false
    verifyOk = true
    await expect(login()).resolves.toMatchObject({ ok: true })
  })

  it('a spray across distinct source addresses in the same routed IPv6 /64 shares one throttle budget', async () => {
    const addr = (i: number) => `2001:db8:aaaa:1::${(i + 1).toString(16)}`
    for (let i = 0; i < MAX_LOGIN_FAILS; i++) {
      await expect(login({ ip: addr(i) })).rejects.toMatchObject({ _tag: 'Unauthorized' })
    }
    await expect(login({ ip: addr(MAX_LOGIN_FAILS) })).rejects.toMatchObject({ statusCode: 429 })
  })

  it('is public — an anonymous caller reaches the credential check', async () => {
    verifyOk = true
    await expect(login()).resolves.toMatchObject({ ok: true })
  })

  it('refuses a cross-origin login attempt before touching the throttle', async () => {
    const event = eventFor('POST')
    event.node.req.headers['sec-fetch-site'] = 'cross-site'
    await expect(runPipelineForEventAsync(event, { op: 'login' })).rejects.toMatchObject({ _tag: 'Forbidden' })
    expect(loginFailIpCount()).toBe(0)
  })

  it('owns its body read (rawBody), so the router cannot buffer an uncapped body before assertBodyLimit', () => {
    const def = buildAuthPipelines().find((p) => p.name === 'login')
    expect(def?.rawBody).toBe(true)
  })
})

describe('logout pipeline', () => {
  it('rejects a caller with no admin session before touching any session state', () => {
    expect(() => logout()).toThrowError(/Authentication required/)
    expect(clearCalls).toBe(0)
    expect(bumpCalls).toBe(0)
  })

  it('clears the session and bumps the revocation epoch for an admin caller', () => {
    expect(logout('admin')).toMatchObject({ ok: true })
    expect(clearCalls).toBe(1)
    expect(bumpCalls).toBe(1)
  })
})
