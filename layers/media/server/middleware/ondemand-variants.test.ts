import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent, defineEventHandler, getRequestHeader, type H3Event } from 'h3'
import { clientIp } from '@michaelthielemann/kestrel-auth'
import { allowlistMode, parseAllowlist, ipAllowed } from '@michaelthielemann/kestrel-access'

// The middleware relies on Nitro auto-imports for these; bind the real implementations, same idiom as
// access/00.ip-allowlist.test.ts. Must run BEFORE the module is imported (a static top-level import would
// evaluate the module ahead of this assignment).
Object.assign(globalThis, { defineEventHandler, getRequestHeader, clientIp, allowlistMode, parseAllowlist, ipAllowed })
const { deniedByAllowlist } = await import('./ondemand-variants')

function eventFor(remoteAddress: string | undefined): H3Event {
  return createEvent({ method: 'GET', url: '/uploads/a/pic.png-w320.webp', headers: {}, socket: { remoteAddress } } as never, { setHeader() {} } as never)
}

const ORIG = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIG }
  delete process.env.KESTREL_IP_ALLOWLIST
  delete process.env.KESTREL_IP_ALLOWLIST_MODE
  delete process.env.KESTREL_TRUST_PROXY
})
afterEach(() => { process.env = { ...ORIG } })

describe('deniedByAllowlist', () => {
  it('never denies when no allow-list is configured (off mode)', () => {
    expect(deniedByAllowlist(eventFor('198.51.100.5'))).toBe(false)
  })

  it('denies an off-list client in enforce mode — the real access gate has not run yet for this middleware', () => {
    process.env.KESTREL_IP_ALLOWLIST = '203.0.113.10/32'
    expect(deniedByAllowlist(eventFor('198.51.100.5'))).toBe(true)
  })

  it('allows an on-list client in enforce mode', () => {
    process.env.KESTREL_IP_ALLOWLIST = '203.0.113.10/32'
    expect(deniedByAllowlist(eventFor('203.0.113.10'))).toBe(false)
  })

  it('never denies in log mode (calibration only, matching the real gate)', () => {
    process.env.KESTREL_IP_ALLOWLIST = '203.0.113.10/32'
    process.env.KESTREL_IP_ALLOWLIST_MODE = 'log'
    expect(deniedByAllowlist(eventFor('198.51.100.5'))).toBe(false)
  })
})
