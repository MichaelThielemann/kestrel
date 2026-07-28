import { describe, it, expect } from 'vitest'
import { evaluateAccess, derivePrincipal, type AccessInput } from './guard'
import { signSession } from '../../../auth/server/utils/session'

const SECRET = 'guard-secret-at-least-32-bytes-long-xxx'
const now = 1_000_000_000_000
const goodCookie = signSession(SECRET, now + 10_000)
const sameOrigin = { secFetchSite: 'same-origin' as const, host: 'cms' }

const base: AccessInput = {
  method: 'GET', path: '/api/pages', csrf: sameOrigin,
  cookie: goodCookie, secret: SECRET, nowMs: now, isPrerender: false,
}

describe('derivePrincipal', () => {
  it('is renderer during prerender, admin with a valid session, else anonymous', () => {
    expect(derivePrincipal({ ...base, isPrerender: true }).role).toBe('renderer')
    expect(derivePrincipal(base).role).toBe('admin')
    expect(derivePrincipal({ ...base, cookie: undefined }).role).toBe('anonymous')
  })
})

describe('evaluateAccess', () => {
  it('admin reads and writes anything', () => {
    expect(evaluateAccess({ ...base, method: 'GET', path: '/api/posts' })).toMatchObject({ allow: true, readScope: 'all' })
    expect(evaluateAccess({ ...base, method: 'POST', path: '/api/pages' }).allow).toBe(true)
  })
  it('anonymous reads any pageLike collection in the public set (published); denied otherwise', () => {
    const anon = { ...base, cookie: undefined }
    const pub = ['pages', 'posts'] // registry-driven pageLike set
    expect(evaluateAccess({ ...anon, method: 'GET', path: '/api/pages' }, pub)).toMatchObject({ allow: true, readScope: 'published' })
    expect(evaluateAccess({ ...anon, method: 'GET', path: '/api/posts' }, pub)).toMatchObject({ allow: true, readScope: 'published' }) // generic
    expect(evaluateAccess({ ...anon, method: 'GET', path: '/api/settings' }, pub)).toMatchObject({ allow: false, status: 401 })
    expect(evaluateAccess({ ...anon, method: 'GET', path: '/api/pages' }, [])).toMatchObject({ allow: false, status: 401 }) // not in public set
    expect(evaluateAccess({ ...anon, method: 'POST', path: '/api/pages', csrf: sameOrigin }, pub)).toMatchObject({ allow: false, status: 401 })
  })
  it('renderer reads PUBLISHED-only (during prerender) — drafts never reach the static site', () => {
    const r = { ...base, cookie: undefined, isPrerender: true }
    expect(evaluateAccess({ ...r, method: 'GET', path: '/api/posts' })).toMatchObject({ allow: true, readScope: 'published' })
  })
  it('the public render entry (GET /api/route) is readable by everyone, scoped per principal', () => {
    const anon = { ...base, cookie: undefined }
    // anonymous live preview → published scope (the route handler enforces published-only)
    expect(evaluateAccess({ ...anon, method: 'GET', path: '/api/route?path=/x&locale=en' })).toMatchObject({ allow: true, readScope: 'published' })
    // an authenticated admin → full scope, so the handler can surface a draft preview
    expect(evaluateAccess({ ...base, method: 'GET', path: '/api/route?path=/x&locale=en' })).toMatchObject({ allow: true, readScope: 'all' })
    // a write to the same path is not exempt
    expect(evaluateAccess({ ...anon, method: 'POST', path: '/api/route', csrf: sameOrigin })).toMatchObject({ allow: false, status: 401 })
  })
  it('CSRF rejects an explicit cross-site write (before policy)', () => {
    const r = evaluateAccess({ ...base, method: 'POST', path: '/api/pages', csrf: { secFetchSite: 'cross-site', host: 'cms' } })
    expect(r).toMatchObject({ allow: false, status: 403 })
  })
  it('bootstrap login/session are always allowed; logout needs a session', () => {
    expect(evaluateAccess({ ...base, method: 'POST', path: '/api/auth/login', cookie: undefined }).allow).toBe(true)
    expect(evaluateAccess({ ...base, method: 'GET', path: '/api/auth/session', cookie: undefined }).allow).toBe(true)
    expect(evaluateAccess({ ...base, method: 'POST', path: '/api/auth/logout', cookie: undefined })).toMatchObject({ allow: false, status: 401 })
    expect(evaluateAccess({ ...base, method: 'POST', path: '/api/auth/logout' }).allow).toBe(true) // admin
  })
  it('the anonymous bootstrap exemption never grants draft-read scope (fail-closed, mirrors isPublicRenderPath)', () => {
    expect(evaluateAccess({ ...base, method: 'GET', path: '/api/auth/session', cookie: undefined }))
      .toMatchObject({ allow: true, readScope: 'published' })
    expect(evaluateAccess({ ...base, method: 'GET', path: '/api/auth/session' }))
      .toMatchObject({ allow: true, readScope: 'all' }) // admin still gets full scope
  })
  it('CSRF runs before the bootstrap exemption: a cross-site login is still 403', () => {
    expect(evaluateAccess({ ...base, method: 'POST', path: '/api/auth/login', cookie: undefined, csrf: { secFetchSite: 'cross-site', host: 'cms' } }))
      .toMatchObject({ allow: false, status: 403 })
  })
  it('401s an expired cookie on a guarded write', () => {
    const expired = signSession(SECRET, now - 1)
    expect(evaluateAccess({ ...base, method: 'DELETE', path: '/api/posts/1', cookie: expired })).toMatchObject({ allow: false, status: 401 })
  })
  it('honours a registered grant: anonymous same-site write to the granted resource is allowed', () => {
    const anon = { ...base, cookie: undefined, method: 'POST', path: '/api/proofing', csrf: sameOrigin }
    const grants = { anonymous: [{ action: 'write' as const, resource: 'proofing' }] }
    // allowed, but the write carries published scope — no draft-read leaks to an anonymous write handler
    expect(evaluateAccess(anon, [], grants)).toMatchObject({ allow: true, readScope: 'published' })
    expect(evaluateAccess(anon, [], {})).toMatchObject({ allow: false, status: 401 }) // no grant → default-deny
    // the grant does not bypass CSRF — a cross-site write is still rejected first
    expect(evaluateAccess({ ...anon, csrf: { secFetchSite: 'cross-site', host: 'cms' } }, [], grants)).toMatchObject({ allow: false, status: 403 })
    // and it does not widen to other resources
    expect(evaluateAccess({ ...anon, path: '/api/secrets' }, [], grants)).toMatchObject({ allow: false, status: 401 })
  })
  it('anonymous cannot reach the pages tooling sub-routes (options, translations)', () => {
    const anon = { ...base, cookie: undefined }
    const pub = ['pages']
    expect(evaluateAccess({ ...anon, method: 'GET', path: '/api/pages/options' }, pub)).toMatchObject({ allow: false, status: 401 })
    expect(evaluateAccess({ ...anon, method: 'GET', path: '/api/pages/5/translations' }, pub)).toMatchObject({ allow: false, status: 401 })
    // admin still reaches them
    expect(evaluateAccess({ ...base, method: 'GET', path: '/api/pages/options' }).allow).toBe(true)
    expect(evaluateAccess({ ...base, method: 'GET', path: '/api/pages/5/translations' }).allow).toBe(true)
  })
})
