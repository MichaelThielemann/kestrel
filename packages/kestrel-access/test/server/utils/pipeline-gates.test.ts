import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createPipelineContext } from '@kestrel/core'
import type { AccessSpec, BuiltCollection, PipelineContext } from '@kestrel/core'
import { clearAccessGrants, registerAccessGrant } from '../../../src/server/utils/grant-registry.js'
import { evaluateAccessGate, evaluateCsrfGate, evaluateIpAllowlistGate } from '../../../src/server/utils/pipeline-gates.js'
import { resetAllowlistConfig } from '../../../src/server/utils/ip-allowlist.js'

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
