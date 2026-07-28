import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { setAuthSession, clearAuthSession, getAuthSession, refreshAuthSession } from './session-cookie'
import { sessionSettings } from './session'
import { _resetSessionEpochCache } from './session-epoch'

// A minimal real H3 event over node's http req/res — enough for getCookie/setCookie to round-trip.
function makeEvent(cookieHeader?: string) {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = '/'
  if (cookieHeader) req.headers.cookie = cookieHeader
  const res = new ServerResponse(req)
  return createEvent(req, res)
}

function setCookieHeaders(event: ReturnType<typeof makeEvent>): string[] {
  const raw = event.node.res.getHeader('set-cookie')
  return Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
}

// A cookie a browser would echo back on the next request: name=value from the Set-Cookie line.
function echo(setCookie: string): string {
  return setCookie.split(';')[0]
}

const ORIG = { ...process.env }
beforeEach(() => {
  process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
  process.env.NODE_ENV = 'test'
  delete process.env.KESTREL_ADMIN_PASSWORD_HASH
  delete process.env.KESTREL_SESSION_EPOCH_FILE
  _resetSessionEpochCache()
})
afterEach(() => {
  process.env = { ...ORIG }
  _resetSessionEpochCache()
})

describe('session-cookie set/get round-trip', () => {
  it('setAuthSession issues a signed cookie that getAuthSession reads back as authenticated', () => {
    const setEv = makeEvent()
    const exp = setAuthSession(setEv)
    const [line] = setCookieHeaders(setEv)
    expect(line).toBeDefined()

    const readEv = makeEvent(echo(line))
    const session = getAuthSession(readEv)
    expect(session.authenticated).toBe(true)
    expect(session.exp).toBe(exp)
  })

  it('carries the hardened cookie attributes (HttpOnly, SameSite=Strict, Path, Secure by default)', () => {
    process.env.NODE_ENV = 'production' // secureCookies defaults on outside dev/test
    const ev = makeEvent()
    setAuthSession(ev)
    const [line] = setCookieHeaders(ev)
    expect(line).toMatch(/HttpOnly/i)
    expect(line).toMatch(/SameSite=Strict/i)
    expect(line).toMatch(/Path=\//i)
    expect(line).toMatch(/Secure/i)
    expect(line.startsWith(sessionSettings().cookieName + '=')).toBe(true)
  })

  it('KESTREL_SECURE_COOKIES=false drops the Secure attribute (dev over http)', () => {
    process.env.KESTREL_SECURE_COOKIES = 'false'
    const ev = makeEvent()
    setAuthSession(ev)
    expect(setCookieHeaders(ev)[0]).not.toMatch(/Secure/i)
  })

  it('getAuthSession returns unauthenticated for no cookie and for a tampered one', () => {
    expect(getAuthSession(makeEvent()).authenticated).toBe(false)
    const ev = makeEvent()
    setAuthSession(ev)
    const tampered = echo(setCookieHeaders(ev)[0]).replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))
    expect(getAuthSession(makeEvent(tampered)).authenticated).toBe(false)
  })
})

describe('clearAuthSession', () => {
  it('emits a max-age=0 expiry cookie so the browser drops the session', () => {
    const ev = makeEvent()
    clearAuthSession(ev)
    const [line] = setCookieHeaders(ev)
    expect(line).toMatch(/Max-Age=0/i)
    expect(line.startsWith(sessionSettings().cookieName + '=')).toBe(true)
  })
})

describe('refreshAuthSession (sliding-expiry wiring)', () => {
  it('does NOT re-issue a freshly-set cookie (more than half the window remains)', () => {
    const setEv = makeEvent()
    setAuthSession(setEv)
    const cookie = echo(setCookieHeaders(setEv)[0])
    const refreshEv = makeEvent(cookie)
    refreshAuthSession(refreshEv)
    expect(setCookieHeaders(refreshEv)).toHaveLength(0) // untouched
  })

  it('is a no-op for an anonymous request (no valid session cookie)', () => {
    const ev = makeEvent()
    refreshAuthSession(ev)
    expect(setCookieHeaders(ev)).toHaveLength(0)
  })

  it('re-issues a session whose remaining lifetime has dropped below half the window (activity extends it)', () => {
    // Mint the cookie under a 1s window (exp ≈ now+1000), then evaluate refresh under a much LONGER window:
    // remaining (~1000ms) is now far below half of the long window, so activity re-issues the cookie.
    process.env.KESTREL_SESSION_MAX_AGE = '1'
    const setEv = makeEvent()
    setAuthSession(setEv)
    const cookie = echo(setCookieHeaders(setEv)[0])

    process.env.KESTREL_SESSION_MAX_AGE = '100000' // ~1.15d idle window; remaining 1s ≪ 50000s half
    const refreshEv = makeEvent(cookie)
    refreshAuthSession(refreshEv)
    expect(setCookieHeaders(refreshEv).length).toBeGreaterThan(0)
  })
})

describe('logout wiring: bumping the epoch kills an already-issued cookie', () => {
  it('a cookie signed before bumpSessionEpoch fails getAuthSession after it', async () => {
    const dir = await import('node:os').then((o) => o.tmpdir())
    const file = `${dir}/kestrel-cookie-epoch-${process.pid}.epoch`
    process.env.KESTREL_SESSION_EPOCH_FILE = file
    _resetSessionEpochCache()
    const { bumpSessionEpoch } = await import('./session-epoch')
    const { rmSync } = await import('node:fs')
    try {
      const setEv = makeEvent()
      setAuthSession(setEv)
      const cookie = echo(setCookieHeaders(setEv)[0])
      expect(getAuthSession(makeEvent(cookie)).authenticated).toBe(true)

      bumpSessionEpoch() // logout.post does exactly this
      expect(getAuthSession(makeEvent(cookie)).authenticated).toBe(false) // the old cookie is dead
    } finally {
      try { rmSync(file) } catch {}
    }
  })
})
