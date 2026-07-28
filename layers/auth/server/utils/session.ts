import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { currentSessionEpoch } from './session-epoch'

export function deriveSigningKey(rawSecret: string, passwordHash?: string, epoch = 0): string {
  // The `epoch` is a server-side revocation counter: bumping it (on logout / force-logout) changes the key
  // so every previously-issued token fails verification immediately — the stateless model's "hard logout".
  return createHmac('sha256', rawSecret).update('kestrel-session-v1').update(passwordHash ?? '').update(`e${epoch}`).digest('base64url')
}

export function signSession(secret: string, expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expMs })).toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifySession(secret: string, value: string | undefined, nowMs: number): { valid: boolean; exp?: number } {
  if (!value || typeof value !== 'string') return { valid: false }
  const dot = value.indexOf('.')
  if (dot <= 0 || dot === value.length - 1) return { valid: false }
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return { valid: false }
  let exp: unknown
  try {
    exp = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp
  } catch {
    return { valid: false }
  }
  if (typeof exp !== 'number' || exp <= nowMs) return { valid: false }
  return { valid: true, exp }
}

/**
 * Sliding-expiry decision: refresh the session cookie once its remaining lifetime drops below HALF the
 * idle window. Activity within the window keeps the session alive (each refresh resets exp to now+maxAge);
 * inactivity longer than the window lets it expire → the admin must log in again. The halfway threshold
 * bounds Set-Cookie churn to at most once per half-window instead of on every request.
 */
export function shouldRefreshSession(exp: number, nowMs: number, maxAgeMs: number): boolean {
  return exp - nowMs < maxAgeMs / 2
}

let devSecret: string | undefined

export interface SessionSettings {
  secret: string
  maxAge: number
  secureCookies: boolean
  cookieName: string
}

export function sessionSettings(): SessionSettings {
  // Treat anything that isn't an EXPLICIT dev signal as production for these safeguards, so a deployment
  // that simply omits NODE_ENV (a common slip when launching `.output/server/index.mjs`) is hardened —
  // not silently downgraded to dev, which would tolerate a missing secret + non-Secure cookies. Vitest
  // sets NODE_ENV=test; KESTREL_DEV=1 is an explicit escape hatch for other dev contexts.
  const explicitDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' || process.env.KESTREL_DEV === '1'
  const isProd = !explicitDev
  const secureCookies = process.env.KESTREL_SECURE_COOKIES !== 'false'
  if (isProd && !secureCookies) {
    throw new Error('KESTREL_SECURE_COOKIES=false is not allowed in production')
  }
  const rawMaxAge = Number(process.env.KESTREL_SESSION_MAX_AGE)
  const maxAge = Number.isFinite(rawMaxAge) && rawMaxAge > 0 ? rawMaxAge : 604800
  let secret = process.env.KESTREL_SESSION_SECRET
  if (!secret) {
    if (isProd) throw new Error('KESTREL_SESSION_SECRET is required in production')
    if (!devSecret) {
      devSecret = randomBytes(32).toString('base64url')
      console.warn('[kestrel auth] KESTREL_SESSION_SECRET not set — using a random per-process dev secret; sessions reset on restart')
    }
    secret = devSecret
  } else if (isProd && Buffer.byteLength(secret) < 32) {
    throw new Error('KESTREL_SESSION_SECRET must be at least 32 bytes in production')
  }
  return {
    secret: deriveSigningKey(secret, process.env.KESTREL_ADMIN_PASSWORD_HASH, currentSessionEpoch()),
    maxAge,
    secureCookies,
    cookieName: secureCookies ? '__Host-kestrel_session' : 'kestrel_session',
  }
}
