import { getCookie, setCookie, type H3Event } from 'h3'
import { signSession, verifySession, sessionSettings, shouldRefreshSession } from './session'

/** Shared session-cookie attributes; only `maxAge` differs between set and clear. */
const baseCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  secure,
  sameSite: 'strict' as const,
  path: '/',
})

export function setAuthSession(event: H3Event): number {
  const { secret, maxAge, secureCookies, cookieName } = sessionSettings()
  const exp = Date.now() + maxAge * 1000
  setCookie(event, cookieName, signSession(secret, exp), { ...baseCookieOptions(secureCookies), maxAge })
  return exp
}

export function clearAuthSession(event: H3Event): void {
  const { secureCookies, cookieName } = sessionSettings()
  setCookie(event, cookieName, '', { ...baseCookieOptions(secureCookies), maxAge: 0 })
}

export function getAuthSession(event: H3Event): { authenticated: boolean; exp?: number } {
  const { secret, cookieName } = sessionSettings()
  const result = verifySession(secret, getCookie(event, cookieName), Date.now())
  return result.valid ? { authenticated: true, exp: result.exp } : { authenticated: false }
}

/**
 * Sliding-expiry: on an authenticated request whose session has passed the halfway point of the idle
 * window, re-issue the cookie with a fresh exp — so activity keeps the admin logged in and inactivity
 * longer than `maxAge` auto-logs-out (the cookie AND the embedded exp lapse). No-op when there is no valid
 * session cookie (anonymous / public requests), so it is safe to call unconditionally on every request.
 */
export function refreshAuthSession(event: H3Event): void {
  const { secret, maxAge, secureCookies, cookieName } = sessionSettings()
  const now = Date.now()
  const current = verifySession(secret, getCookie(event, cookieName), now)
  if (!current.valid || current.exp === undefined) return
  if (!shouldRefreshSession(current.exp, now, maxAge * 1000)) return
  const exp = now + maxAge * 1000
  setCookie(event, cookieName, signSession(secret, exp), { ...baseCookieOptions(secureCookies), maxAge })
}
