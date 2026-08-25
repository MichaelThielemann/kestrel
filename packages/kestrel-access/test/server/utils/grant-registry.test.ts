import { describe, it, expect, beforeEach } from 'vitest'
import { registerAccessGrant, registeredGrants, clearAccessGrants } from '../../../src/server/utils/grant-registry.js'

describe('access grant registry', () => {
  beforeEach(clearAccessGrants)

  it('records a grant per role and exposes the map', () => {
    registerAccessGrant('anonymous', { action: 'write', resource: 'proofing' })
    expect(registeredGrants()).toEqual({ anonymous: [{ action: 'write', resource: 'proofing' }] })
  })

  it('accumulates multiple grants for the same role', () => {
    registerAccessGrant('anonymous', { action: 'write', resource: 'a' })
    registerAccessGrant('anonymous', { action: 'read', resource: 'b', scope: 'published' })
    expect(registeredGrants().anonymous).toHaveLength(2)
  })

  it('is empty until something registers (default-deny stays intact)', () => {
    expect(registeredGrants()).toEqual({})
  })

  it('clearAccessGrants empties it', () => {
    registerAccessGrant('anonymous', { action: 'write', resource: 'x' })
    clearAccessGrants()
    expect(registeredGrants()).toEqual({})
  })

  it('refuses over-broad anonymous grants (wildcard / draft-read), allows a specific one', () => {
    expect(() => registerAccessGrant('anonymous', { action: 'write', resource: '*' })).toThrow()
    expect(() => registerAccessGrant('anonymous', { action: 'read', resource: 'x', scope: 'all' })).toThrow()
    expect(() => registerAccessGrant('anonymous', { action: 'write', resource: 'proofing' })).not.toThrow()
    // a non-anonymous role may still hold a wildcard (e.g. an admin-like custom role)
    expect(() => registerAccessGrant('admin', { action: 'write', resource: '*' })).not.toThrow()
  })

  it('refuses an anonymous READ grant with an omitted or "all" scope (evaluator hard-limits every non-admin role to published)', () => {
    expect(() => registerAccessGrant('anonymous', { action: 'read', resource: 'reviews' })).toThrowError(/published/i)
    expect(() => registerAccessGrant('anonymous', { action: 'read', resource: 'reviews', scope: 'published' })).not.toThrow()
    // an anonymous WRITE grant carries no read scope, so an omitted scope is fine (the proofing back-channel).
    expect(() => registerAccessGrant('anonymous', { action: 'write', resource: 'proofing' })).not.toThrow()
  })

  it('extends the same rule to every non-admin role, not just anonymous', () => {
    expect(() => registerAccessGrant('renderer', { action: 'read', resource: 'reviews' })).toThrowError(/published/i)
    expect(() => registerAccessGrant('renderer', { action: 'read', resource: 'reviews', scope: 'all' })).toThrowError(/published/i)
    expect(() => registerAccessGrant('renderer', { action: 'read', resource: 'reviews', scope: 'published' })).not.toThrow()
    // admin is exempt — an omitted or 'all' scope on an admin read grant is fine (decide's read:all is
    // admin-only anyway, so this cannot silently mean something else).
    expect(() => registerAccessGrant('admin', { action: 'read', resource: 'reviews' })).not.toThrow()
  })
})
