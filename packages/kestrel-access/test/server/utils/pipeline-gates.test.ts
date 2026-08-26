import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { createPipelineContext } from '@michaelthielemann/kestrel-core'
import type { AccessSpec, BuiltCollection, PipelineContext } from '@michaelthielemann/kestrel-core'
import { sessionSettings } from '@michaelthielemann/kestrel-auth'
import { clearAccessGrants, registerAccessGrant } from '../../../src/server/utils/grant-registry.js'
import {
  evaluateAccessGate, evaluateCsrfGate, evaluateIpAllowlistGate, pipelineRequestFor, resolveEventPrincipal,
} from '../../../src/server/utils/pipeline-gates.js'
import { resetAllowlistConfig } from '../../../src/server/utils/ip-allowlist.js'

// resolveEventPrincipal's two collaborators, mocked so the tests below drive and observe the wiring
// (what it reads off the event, what it passes on) rather than session-cookie verification, which has
// its own suite.
let rendererContextValue = false
let derivePrincipalCalls: unknown[] = []
let derivePrincipalResult: unknown = { userId: 'admin', role: 'admin' }

vi.mock('../../../src/server/utils/render-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/server/utils/render-context.js')>()
  return { ...actual, isRendererContext: () => rendererContextValue }
})

vi.mock('../../../src/server/utils/guard.js', () => ({
  derivePrincipal: (input: unknown) => {
    derivePrincipalCalls.push(input)
    return derivePrincipalResult
  },
}))

function h3EventFor(options: { method?: string, ip?: string, headers?: Record<string, string>, principal?: unknown } = {}): H3Event {
  const event = createEvent(
    { method: options.method ?? 'GET', url: '/api/thing', headers: options.headers ?? {}, socket: { remoteAddress: options.ip ?? '203.0.113.1' } } as never,
    { setHeader() {} } as never,
  )
  if (options.principal !== undefined) event.context.principal = options.principal
  return event
}

const collection = (name: string): BuiltCollection => ({ name, def: { name } } as unknown as BuiltCollection)

function ctxFor(op: string, role: string | null, options: { collection?: string, ip?: string, method?: string, headers?: Record<string, string> } = {}): PipelineContext {
  return createPipelineContext({
    op,
    collection: options.collection ? collection(options.collection) : null,
    principal: role ? { userId: role === 'admin' ? 'admin' : null, role } : null,
    request: { ip: options.ip ?? '203.0.113.1', method: options.method ?? 'POST', headers: options.headers ?? {} },
  })
}

const PUBLIC_READ: AccessSpec = { public: true, scope: 'published' }
const ADMIN_READ: AccessSpec = { role: 'admin', scope: 'all' }
const ADMIN_WRITE: AccessSpec = { role: 'admin' }

afterEach(() => clearAccessGrants())

// Each case restates a decision the route guard makes today, so the two can be compared line by line.
describe('access gate — parity with the route guard', () => {
  it('admin reads at full scope and may write anything', () => {
    expect(evaluateAccessGate(PUBLIC_READ, ctxFor('readMany', 'admin', { collection: 'pages' }))).toMatchObject({ allowed: true, readScope: 'all' })
    expect(evaluateAccessGate(ADMIN_READ, ctxFor('readMany', 'admin', { collection: 'settings' }))).toMatchObject({ allowed: true, readScope: 'all' })
    expect(evaluateAccessGate(ADMIN_WRITE, ctxFor('createOne', 'admin', { collection: 'pages' })).allowed).toBe(true)
  })

  it('anonymous reads a publicly declared collection, published-only', () => {
    expect(evaluateAccessGate(PUBLIC_READ, ctxFor('readMany', 'anonymous', { collection: 'pages' })))
      .toMatchObject({ allowed: true, readScope: 'published' })
  })

  it('anonymous is refused with 401 on a collection that declares no public access', () => {
    expect(evaluateAccessGate(ADMIN_READ, ctxFor('readMany', 'anonymous', { collection: 'settings' })))
      .toMatchObject({ allowed: false, status: 401, message: 'Authentication required' })
  })

  it('anonymous is refused with 401 on every write, publicly readable collection or not', () => {
    expect(evaluateAccessGate(ADMIN_WRITE, ctxFor('createOne', 'anonymous', { collection: 'pages' })))
      .toMatchObject({ allowed: false, status: 401 })
  })

  it('a missing principal is treated as anonymous, never as trusted', () => {
    expect(evaluateAccessGate(ADMIN_READ, ctxFor('readMany', null, { collection: 'settings' })).allowed).toBe(false)
    expect(evaluateAccessGate(PUBLIC_READ, ctxFor('readMany', null, { collection: 'pages' })))
      .toMatchObject({ allowed: true, readScope: 'published' })
  })

  it('the renderer reads anything but published-only, and may not write', () => {
    expect(evaluateAccessGate(ADMIN_READ, ctxFor('readMany', 'renderer', { collection: 'settings' })))
      .toMatchObject({ allowed: true, readScope: 'published' })
    expect(evaluateAccessGate(ADMIN_WRITE, ctxFor('createOne', 'renderer', { collection: 'pages' })).allowed).toBe(false)
  })

  it('honours a registered grant, which is consulted for the pipeline exactly as for a route', () => {
    const ctx = ctxFor('createOne', 'anonymous', { collection: 'proofing' })
    expect(evaluateAccessGate(ADMIN_WRITE, ctx).allowed).toBe(false)
    registerAccessGrant('anonymous', { action: 'write', resource: 'proofing' })
    expect(evaluateAccessGate(ADMIN_WRITE, ctx).allowed).toBe(true)
  })

  it('a write grant never confers draft-read', () => {
    registerAccessGrant('anonymous', { action: 'write', resource: 'proofing' })
    expect(evaluateAccessGate(ADMIN_WRITE, ctxFor('createOne', 'anonymous', { collection: 'proofing' })).readScope).toBe('published')
  })

  it('an explicitly public non-read pipeline (login) admits an anonymous caller', () => {
    expect(evaluateAccessGate({ public: true }, ctxFor('login', 'anonymous')).allowed).toBe(true)
    expect(evaluateAccessGate({ role: 'admin' }, ctxFor('logout', 'anonymous')))
      .toMatchObject({ allowed: false, status: 401 })
  })

  it('refuses a public READ declaration that omits the published scope', () => {
    expect(() => evaluateAccessGate({ public: true }, ctxFor('readMany', 'anonymous', { collection: 'pages' })))
      .toThrowError(/scope: 'published'/)
  })
})

describe('csrf gate', () => {
  it('rejects a cross-origin write with 403', () => {
    expect(evaluateCsrfGate(ctxFor('createOne', 'admin', { headers: { 'sec-fetch-site': 'cross-site' } })))
      .toMatchObject({ allowed: false, status: 403, message: 'Cross-origin write rejected' })
  })

  it('admits a same-origin write and a write from a non-browser client', () => {
    expect(evaluateCsrfGate(ctxFor('createOne', 'admin', { headers: { 'sec-fetch-site': 'same-origin' } })).allowed).toBe(true)
    expect(evaluateCsrfGate(ctxFor('createOne', 'admin')).allowed).toBe(true)
  })

  it('compares the Origin against the Host when Sec-Fetch-Site is absent', () => {
    expect(evaluateCsrfGate(ctxFor('createOne', 'admin', { headers: { origin: 'https://evil.test', host: 'cms.test' } })).allowed).toBe(false)
    expect(evaluateCsrfGate(ctxFor('createOne', 'admin', { headers: { origin: 'https://cms.test', host: 'cms.test' } })).allowed).toBe(true)
  })
})

describe('ip allowlist gate', () => {
  const ORIG = { ...process.env }
  beforeEach(() => { resetAllowlistConfig() })
  afterEach(() => { process.env = { ...ORIG }; resetAllowlistConfig() })

  it('is inert when no list is configured', () => {
    delete process.env.KESTREL_IP_ALLOWLIST
    expect(evaluateIpAllowlistGate(ctxFor('createOne', 'admin')).allowed).toBe(true)
  })

  it('blocks an address outside the list and admits one inside it', () => {
    process.env.KESTREL_IP_ALLOWLIST = '10.0.0.0/8'
    expect(evaluateIpAllowlistGate(ctxFor('createOne', 'admin', { ip: '203.0.113.1' })))
      .toMatchObject({ allowed: false, status: 403, message: 'Forbidden' })
    expect(evaluateIpAllowlistGate(ctxFor('createOne', 'admin', { ip: '10.1.2.3' })).allowed).toBe(true)
  })

  it('never blocks the renderer, which reaches the gate on an in-process request', () => {
    process.env.KESTREL_IP_ALLOWLIST = '10.0.0.0/8'
    expect(evaluateIpAllowlistGate(ctxFor('readMany', 'renderer', { ip: '203.0.113.1' })).allowed).toBe(true)
  })

  it('observes without blocking in log mode', () => {
    process.env.KESTREL_IP_ALLOWLIST = '10.0.0.0/8'
    process.env.KESTREL_IP_ALLOWLIST_MODE = 'log'
    expect(evaluateIpAllowlistGate(ctxFor('createOne', 'admin', { ip: '203.0.113.1' })).allowed).toBe(true)
  })
})

describe('resolveEventPrincipal', () => {
  beforeEach(() => {
    rendererContextValue = false
    derivePrincipalCalls = []
    derivePrincipalResult = { userId: 'admin', role: 'admin' }
  })

  it('returns the exact principal already resolved onto the event, without deriving one', () => {
    const existing = { userId: 'x', role: 'admin' }
    expect(resolveEventPrincipal(h3EventFor({ principal: existing }))).toBe(existing)
    expect(derivePrincipalCalls).toHaveLength(0)
  })

  it('derives the principal from the request when none is set on the event', () => {
    const result = resolveEventPrincipal(h3EventFor())
    expect(result).toEqual({ userId: 'admin', role: 'admin' })
    expect(derivePrincipalCalls).toHaveLength(1)
  })

  it('passes the cookie read under the configured cookie name, and the session secret, to derivePrincipal', () => {
    const settings = sessionSettings()
    const before = Date.now()
    resolveEventPrincipal(h3EventFor({ headers: { cookie: `${settings.cookieName}=abc123; other=zzz` } }))
    const after = Date.now()
    expect(derivePrincipalCalls).toHaveLength(1)
    const input = derivePrincipalCalls[0] as { cookie?: string, secret?: string, nowMs?: number, isPrerender?: boolean }
    expect(input.cookie).toBe('abc123')
    expect(input.secret).toBe(settings.secret)
    expect(input.nowMs).toBeGreaterThanOrEqual(before)
    expect(input.nowMs).toBeLessThanOrEqual(after)
    expect(input.isPrerender).toBe(false)
  })

  it('has no cookie to pass when the request carries none', () => {
    resolveEventPrincipal(h3EventFor())
    expect((derivePrincipalCalls[0] as { cookie?: string }).cookie).toBeUndefined()
  })

  it('isPrerender is false when neither the prerender flag nor the renderer context is set', () => {
    resolveEventPrincipal(h3EventFor())
    expect(derivePrincipalCalls[0]).toMatchObject({ isPrerender: false })
  })

  it('isPrerender is true inside the publisher render context', () => {
    rendererContextValue = true
    resolveEventPrincipal(h3EventFor())
    expect(derivePrincipalCalls[0]).toMatchObject({ isPrerender: true })
  })
})

describe('pipelineRequestFor', () => {
  it('carries the real ip, method and headers', () => {
    const req = pipelineRequestFor(h3EventFor({ method: 'POST', ip: '198.51.100.7', headers: { origin: 'https://cms.test' } }))
    expect(req).toMatchObject({ ip: '198.51.100.7', method: 'POST', headers: { origin: 'https://cms.test' } })
  })

  it('copies only the whitelisted headers that are actually present', () => {
    const { headers } = pipelineRequestFor(h3EventFor({ headers: { origin: 'https://cms.test', 'x-custom': 'nope' } }))
    expect(headers.origin).toBe('https://cms.test')
    // Absent (and non-whitelisted) headers must not appear as keys at all — `toBeUndefined()` would also
    // pass for a present key holding `undefined`, which is exactly what a flipped `!==` guard produces.
    expect('sec-fetch-site' in headers).toBe(false)
    expect('referer' in headers).toBe(false)
    expect('host' in headers).toBe(false)
    expect('x-custom' in headers).toBe(false)
  })
})
