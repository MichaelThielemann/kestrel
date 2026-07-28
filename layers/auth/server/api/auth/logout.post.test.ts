import { describe, it, expect, beforeEach } from 'vitest'
import { createError } from 'h3'

interface FakeEvent { context: { principal?: { role: string } } }

let clearCalls: number
let bumpCalls: number

// The handler is a Nitro route: requireAdmin is the access-layer backstop every mutating handler calls
// (see require-admin.ts) — its own correctness is covered by require-admin.test.ts.
Object.assign(globalThis, {
  defineEventHandler: (h: unknown) => h,
  createError,
  requireAdmin: (event: FakeEvent) => {
    if (event.context.principal?.role !== 'admin') throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  },
  clearAuthSession: () => { clearCalls++ },
  bumpSessionEpoch: () => { bumpCalls++ },
})

const handler = (await import('./logout.post')).default as unknown as (event: FakeEvent) => unknown

beforeEach(() => { clearCalls = 0; bumpCalls = 0 })

describe('POST /api/auth/logout', () => {
  it('rejects a caller with no admin session before touching any session state', () => {
    const event: FakeEvent = { context: {} }
    expect(() => handler(event)).toThrowError(/Unauthorized/)
    expect(clearCalls).toBe(0)
    expect(bumpCalls).toBe(0)
  })

  it('clears the session and bumps the revocation epoch for an admin caller', () => {
    const event: FakeEvent = { context: { principal: { role: 'admin' } } }
    expect(handler(event)).toMatchObject({ ok: true })
    expect(clearCalls).toBe(1)
    expect(bumpCalls).toBe(1)
  })
})
