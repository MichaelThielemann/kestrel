import { describe, it, expect } from 'vitest'
import { derivePrincipal, type PrincipalInput } from '../../../src/server/utils/guard.js'
import { signSession } from '@kestrel/auth'

const SECRET = 'guard-secret-at-least-32-bytes-long-xxx'
const now = 1_000_000_000_000
const goodCookie = signSession(SECRET, now + 10_000)

const base: PrincipalInput = { cookie: goodCookie, secret: SECRET, nowMs: now, isPrerender: false }

describe('derivePrincipal', () => {
  it('is renderer during prerender, admin with a valid session, else anonymous', () => {
    expect(derivePrincipal({ ...base, isPrerender: true }).role).toBe('renderer')
    expect(derivePrincipal(base).role).toBe('admin')
    expect(derivePrincipal({ ...base, cookie: undefined }).role).toBe('anonymous')
  })

  it('rejects a tampered or expired session cookie', () => {
    expect(derivePrincipal({ ...base, cookie: signSession(SECRET, now - 1) }).role).toBe('anonymous')
    expect(derivePrincipal({ ...base, cookie: goodCookie, secret: 'another-secret-at-least-32-bytes-xxxx' }).role).toBe('anonymous')
  })

  it('prefers the renderer signal over a session cookie', () => {
    expect(derivePrincipal({ ...base, isPrerender: true }).userId).toBe('renderer')
  })
})
