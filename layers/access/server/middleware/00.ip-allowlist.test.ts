import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { createEvent, defineEventHandler, createError, getRequestHeader, type H3Event } from 'h3'
import { clientIp } from '../../../auth/server/utils/client-ip'
import { allowlistMode, parseAllowlist, ipAllowed, ipv4ToInt } from '../utils/ip-allowlist'
import { isRendererContext, isStageGatePassedContext, markStageGatePassed } from '../utils/render-context'

// The middleware relies on Nitro auto-imports; bind the real implementations before importing it.
Object.assign(globalThis, {
  defineEventHandler, createError, getRequestHeader, clientIp,
  allowlistMode, parseAllowlist, ipAllowed, ipv4ToInt, isRendererContext, isStageGatePassedContext, markStageGatePassed,
})

/**
 * `remoteAddress: ''` mirrors the socket Nitro's in-process `localFetch` hands the middleware stack
 * (node-mock-http's Socket initialises it to the empty string); `undefined` is what a worker listening on
 * a unix domain socket reports. A real TCP listener always reports a peer address.
 */
function eventFor(remoteAddress: string | undefined, headers: Record<string, string> = {}): H3Event {
  return createEvent({ method: 'GET', url: '/about', headers, socket: { remoteAddress } } as never, { setHeader() {} } as never)
}

/**
 * A fresh gate AND a fresh stage-gate storage, so a mark set by an earlier scenario cannot be visible to
 * this one. `enterWith` mutates the current async frame; under Node 22 inside vitest's runner that
 * mutation reaches the root and no `setImmediate` or unrelated `run()` can shed it, so every peerless
 * request after the first admitted one was wrongly exempted. Re-binding the auto-imports to the
 * re-imported module gives each scenario its own `AsyncLocalStorage` instance, which nothing can outlive.
 * A real listener never had this problem — replaying the same sequence outside vitest blocks correctly on
 * both Node 22 and 24.
 */
async function loadGate(): Promise<(event: H3Event) => unknown> {
  vi.resetModules()
  const ctx = await import('../utils/render-context')
  Object.assign(globalThis, {
    isRendererContext: ctx.isRendererContext,
    isStageGatePassedContext: ctx.isStageGatePassedContext,
    markStageGatePassed: ctx.markStageGatePassed,
  })
  return (await import('./00.ip-allowlist')).default
}

/** The handler is synchronous, so a direct call throws instead of rejecting — go through an async call. */
async function callGate(gate: (event: H3Event) => unknown, event: H3Event): Promise<void> {
  await gate(event)
}

/** One request arriving on its own connection: fresh module (env is cached) and fresh async context. */
async function runGate(event: H3Event): Promise<void> {
  await inFreshContext(async () => callGate(await loadGate(), event))
}

/**
 * Run in a fresh async context, so the gate's `enterWith` mark cannot reach the surrounding test — every
 * scenario has to establish its own, the way a separate incoming connection does.
 */
function inFreshContext<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => { setImmediate(() => { fn().then(resolve, reject) }) })
}

const ORIG = { ...process.env }
let warn: MockInstance
beforeEach(() => {
  process.env = { ...ORIG, KESTREL_IP_ALLOWLIST: '203.0.113.10/32' }
  delete process.env.KESTREL_IP_ALLOWLIST_MODE
  delete process.env.KESTREL_TRUST_PROXY
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  process.env = { ...ORIG }
})

describe('ip-allowlist middleware', () => {
  it('blocks an off-list external client', async () => {
    await expect(runGate(eventFor('198.51.100.5'))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('lets an on-list external client through', async () => {
    await expect(runGate(eventFor('203.0.113.10'))).resolves.toBeUndefined()
  })

  it('blocks a peerless request that no admitted request spawned (unix-socket listener)', async () => {
    await expect(runGate(eventFor(''))).rejects.toMatchObject({ statusCode: 403 })
    await expect(runGate(eventFor(undefined))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('does not block the in-process sub-request (SSR $fetch / preview) of an admitted request', async () => {
    await inFreshContext(async () => {
      const gate = await loadGate()
      await callGate(gate, eventFor('203.0.113.10'))
      await expect(callGate(gate, eventFor(''))).resolves.toBeUndefined()
      await expect(callGate(gate, eventFor(undefined))).resolves.toBeUndefined()
    })
  })

  it('does not carry that exemption over to a peerless request in another context', async () => {
    await runGate(eventFor('203.0.113.10'))
    await expect(runGate(eventFor(''))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('keeps gating a peer-bearing request made from inside an admitted context', async () => {
    await inFreshContext(async () => {
      const gate = await loadGate()
      await callGate(gate, eventFor('203.0.113.10'))
      await expect(callGate(gate, eventFor('198.51.100.5'))).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  it('still blocks an off-list client behind a trusted proxy even without a socket peer', async () => {
    process.env.KESTREL_TRUST_PROXY = '1'
    await expect(runGate(eventFor(undefined, { 'x-forwarded-for': '198.51.100.5' }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('warns about each individual token it drops, so a mixed valid/invalid list is not silently under-enforced', async () => {
    process.env.KESTREL_IP_ALLOWLIST = '203.0.113.10/32, 2a02:8109::/48'
    await runGate(eventFor('203.0.113.10'))
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('2a02:8109::/48'))).toBe(true)
  })

  it('warns once, naming KESTREL_TRUST_PROXY, when it cannot resolve an IPv4 client address', async () => {
    await inFreshContext(async () => {
      const gate = await loadGate()
      await expect(callGate(gate, eventFor(undefined))).rejects.toMatchObject({ statusCode: 403 })
      await expect(callGate(gate, eventFor(undefined))).rejects.toMatchObject({ statusCode: 403 })
    })
    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('KESTREL_TRUST_PROXY'))).toHaveLength(1)
  })

  it('log mode never blocks', async () => {
    process.env.KESTREL_IP_ALLOWLIST_MODE = 'log'
    await expect(runGate(eventFor('198.51.100.5'))).resolves.toBeUndefined()
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('would block 198.51.100.5'))).toBe(true)
  })

  it('log mode reports the external request, not the in-process renders it spawns', async () => {
    process.env.KESTREL_IP_ALLOWLIST_MODE = 'log'
    await inFreshContext(async () => {
      const gate = await loadGate()
      await callGate(gate, eventFor('198.51.100.5'))
      await expect(callGate(gate, eventFor(''))).resolves.toBeUndefined()
    })
    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('would block'))).toHaveLength(1)
  })
})
