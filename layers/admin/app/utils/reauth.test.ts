import { describe, it, expect, vi } from 'vitest'
import { reauthTarget, makeReauthInterceptor } from './reauth'

describe('reauthTarget', () => {
  it('returns the login redirect (with a back-link) for a guarded /api 401 from an admin route', () => {
    expect(reauthTarget({ status: 401, url: '/api/pages', currentPath: '/admin/pages' }))
      .toBe('/admin/login?redirect=%2Fadmin%2Fpages')
  })

  it('preserves the query string of the current location in the back-link', () => {
    expect(reauthTarget({ status: 401, url: '/api/pages?x=1', currentPath: '/admin/pages?tab=seo' }))
      .toBe('/admin/login?redirect=' + encodeURIComponent('/admin/pages?tab=seo'))
  })

  it('tolerates an absolute request url', () => {
    expect(reauthTarget({ status: 401, url: 'http://localhost:3000/api/pages', currentPath: '/admin' }))
      .toBe('/admin/login?redirect=%2Fadmin')
  })

  it('is null for a non-401 status', () => {
    expect(reauthTarget({ status: 500, url: '/api/x', currentPath: '/admin' })).toBeNull()
    expect(reauthTarget({ status: 403, url: '/api/x', currentPath: '/admin' })).toBeNull()
  })

  it('is null for a non-/api request', () => {
    expect(reauthTarget({ status: 401, url: '/admin/foo', currentPath: '/admin' })).toBeNull()
  })

  it('is null for the auth-bootstrap endpoints (a wrong-password login must not loop)', () => {
    expect(reauthTarget({ status: 401, url: '/api/login', currentPath: '/admin/login' })).toBeNull()
    expect(reauthTarget({ status: 401, url: '/api/session', currentPath: '/admin' })).toBeNull()
    expect(reauthTarget({ status: 401, url: '/api/logout', currentPath: '/admin' })).toBeNull()
  })

  it('only the exact bootstrap paths are exempt — a guarded endpoint under an "auth"-named collection still re-auths', () => {
    expect(reauthTarget({ status: 401, url: '/api/auth/5', currentPath: '/admin/auth' }))
      .toBe('/admin/login?redirect=%2Fadmin%2Fauth')
  })

  it('is null when already on the login page (no redirect loop)', () => {
    expect(reauthTarget({ status: 401, url: '/api/pages', currentPath: '/admin/login?redirect=%2Fadmin' })).toBeNull()
  })

  it('is null for a non-admin (public/SSG) location', () => {
    expect(reauthTarget({ status: 401, url: '/api/pages', currentPath: '/blog' })).toBeNull()
  })
})

describe('makeReauthInterceptor', () => {
  it('on a guarded /api 401 from an admin page: resets auth then redirects', () => {
    const reset = vi.fn(); const navigate = vi.fn()
    const onError = makeReauthInterceptor({ currentPath: () => '/admin/posts/3', reset, navigate })
    onError({ request: '/api/posts/3', response: { status: 401 } })
    expect(reset).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/admin/login?redirect=%2Fadmin%2Fposts%2F3')
  })

  it('reads the url from a Request-like object', () => {
    const navigate = vi.fn()
    makeReauthInterceptor({ currentPath: () => '/admin', reset: () => {}, navigate })(
      { request: { url: '/api/things' }, response: { status: 401 } },
    )
    expect(navigate).toHaveBeenCalledWith('/admin/login?redirect=%2Fadmin')
  })

  it('does nothing for a 401 from the auth endpoints', () => {
    const reset = vi.fn(); const navigate = vi.fn()
    makeReauthInterceptor({ currentPath: () => '/admin/login', reset, navigate })(
      { request: '/api/login', response: { status: 401 } },
    )
    expect(reset).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does nothing for non-401s or a public location', () => {
    const reset = vi.fn(); const navigate = vi.fn()
    const admin = makeReauthInterceptor({ currentPath: () => '/admin/x', reset, navigate })
    admin({ request: '/api/x', response: { status: 500 } })
    admin({ request: '/api/x' }) // no response at all (network error)
    makeReauthInterceptor({ currentPath: () => '/blog', reset, navigate })({ request: '/api/x', response: { status: 401 } })
    expect(reset).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
