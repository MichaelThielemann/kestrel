import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signSession, verifySession, sessionSettings, deriveSigningKey, shouldRefreshSession } from '../../../src/server/utils/session.js'
import { currentSessionEpoch, bumpSessionEpoch, _resetSessionEpochCache } from '../../../src/server/utils/session-epoch.js'

const SECRET = 'test-secret-at-least-32-bytes-long-xxxxx'
const now = 1_000_000_000_000

describe('shouldRefreshSession (sliding-expiry)', () => {
  const maxAge = 3600_000 // 1h idle window
  it('does NOT refresh a freshly-issued session (more than half the window remains)', () => {
    expect(shouldRefreshSession(now + maxAge, now, maxAge)).toBe(false)
    expect(shouldRefreshSession(now + maxAge * 0.75, now, maxAge)).toBe(false)
  })
  it('refreshes once the remaining lifetime drops below half the window (activity keeps it alive)', () => {
    expect(shouldRefreshSession(now + maxAge * 0.4, now, maxAge)).toBe(true)
    expect(shouldRefreshSession(now + 1, now, maxAge)).toBe(true)
  })
})

describe('session token', () => {
  it('round-trips a valid token', () => {
    const value = signSession(SECRET, now + 1000)
    const r = verifySession(SECRET, value, now)
    expect(r.valid).toBe(true)
    expect(r.exp).toBe(now + 1000)
  })

  it('rejects a tampered payload', () => {
    const value = signSession(SECRET, now + 1000)
    const tampered = 'x' + value.slice(1)
    expect(verifySession(SECRET, tampered, now).valid).toBe(false)
  })

  it('rejects a wrong secret', () => {
    const value = signSession(SECRET, now + 1000)
    expect(verifySession('another-secret-at-least-32-bytes-yyyyy', value, now).valid).toBe(false)
  })

  it('rejects an expired token', () => {
    const value = signSession(SECRET, now - 1)
    expect(verifySession(SECRET, value, now).valid).toBe(false)
  })

  it('rejects malformed / empty values', () => {
    expect(verifySession(SECRET, undefined, now).valid).toBe(false)
    expect(verifySession(SECRET, 'no-dot', now).valid).toBe(false)
    expect(verifySession(SECRET, '.justsig', now).valid).toBe(false)
  })
})

describe('sessionSettings', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('uses KESTREL_SESSION_SECRET when set', () => {
    process.env.KESTREL_SESSION_SECRET = SECRET
    const s = sessionSettings()
    expect(s.secret).toBe(deriveSigningKey(SECRET, process.env.KESTREL_ADMIN_PASSWORD_HASH, currentSessionEpoch()))
    expect(s.maxAge).toBe(604800)
    expect(s.secureCookies).toBe(true)
    expect(s.cookieName).toBe('__Host-kestrel_session')
  })

  it('drops the __Host- prefix when secureCookies is false', () => {
    process.env.KESTREL_SESSION_SECRET = SECRET
    process.env.KESTREL_SECURE_COOKIES = 'false'
    const s = sessionSettings()
    expect(s.secureCookies).toBe(false)
    expect(s.cookieName).toBe('kestrel_session')
  })

  it('throws in production when the secret is missing', () => {
    delete process.env.KESTREL_SESSION_SECRET
    process.env.NODE_ENV = 'production'
    expect(() => sessionSettings()).toThrowError(/KESTREL_SESSION_SECRET/)
  })

  it('falls back to a generated dev secret when missing outside production', () => {
    delete process.env.KESTREL_SESSION_SECRET
    process.env.NODE_ENV = 'development'
    const a = sessionSettings().secret
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThanOrEqual(32)
  })

  it('rejects non-positive / non-numeric KESTREL_SESSION_MAX_AGE and falls back to default', () => {
    process.env.KESTREL_SESSION_SECRET = SECRET
    process.env.KESTREL_SESSION_MAX_AGE = '-5'
    expect(sessionSettings().maxAge).toBe(604800)
    process.env.KESTREL_SESSION_MAX_AGE = '0'
    expect(sessionSettings().maxAge).toBe(604800)
    process.env.KESTREL_SESSION_MAX_AGE = 'abc'
    expect(sessionSettings().maxAge).toBe(604800)
    process.env.KESTREL_SESSION_MAX_AGE = '300'
    expect(sessionSettings().maxAge).toBe(300)
  })
})

describe('sessionSettings production guards', () => {
  const KEYS = ['NODE_ENV', 'KESTREL_SECURE_COOKIES', 'KESTREL_SESSION_SECRET', 'KESTREL_DEV'] as const
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k] })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) Reflect.deleteProperty(process.env, k); else process.env[k] = saved[k] }
  })

  it('throws in production when KESTREL_SECURE_COOKIES=false', () => {
    process.env.NODE_ENV = 'production'
    process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
    process.env.KESTREL_SECURE_COOKIES = 'false'
    expect(() => sessionSettings()).toThrowError(/SECURE_COOKIES=false/)
  })
  it('throws in production when the secret is shorter than 32 bytes', () => {
    process.env.NODE_ENV = 'production'
    process.env.KESTREL_SESSION_SECRET = 'short'
    delete process.env.KESTREL_SECURE_COOKIES
    expect(() => sessionSettings()).toThrowError(/at least 32 bytes/)
  })
  it('accepts a valid production config', () => {
    process.env.NODE_ENV = 'production'
    process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
    delete process.env.KESTREL_SECURE_COOKIES
    expect(() => sessionSettings()).not.toThrow()
  })

  // `nuxt generate` runs with NODE_ENV=production and prerenders every page through `/api/route`, which
  // goes through the access guard and therefore `sessionSettings()`. A prerender request never sets a
  // cookie, so the assertion is moot there.
  it('does not reject KESTREL_SECURE_COOKIES=false while prerendering', () => {
    process.env.NODE_ENV = 'production'
    process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
    process.env.KESTREL_SECURE_COOKIES = 'false'
    expect(() => sessionSettings({ prerender: true })).not.toThrow()
  })
  it('does not require a secret while prerendering — generate never touches sessions', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.KESTREL_SESSION_SECRET
    expect(() => sessionSettings({ prerender: true })).not.toThrow()
  })
  it('still requires a secret for a real production request', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.KESTREL_SESSION_SECRET
    expect(() => sessionSettings({ prerender: false })).toThrowError(/KESTREL_SESSION_SECRET/)
  })

  it('treats UNSET NODE_ENV as production — refuses to boot on a missing secret', () => {
    delete process.env.NODE_ENV
    delete process.env.KESTREL_DEV
    delete process.env.KESTREL_SESSION_SECRET
    expect(() => sessionSettings()).toThrowError(/KESTREL_SESSION_SECRET/)
  })
  it('treats UNSET NODE_ENV as production — rejects KESTREL_SECURE_COOKIES=false', () => {
    delete process.env.NODE_ENV
    delete process.env.KESTREL_DEV
    process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
    process.env.KESTREL_SECURE_COOKIES = 'false'
    expect(() => sessionSettings()).toThrowError(/SECURE_COOKIES=false/)
  })
  it('KESTREL_DEV=1 is an explicit dev signal — permits the random-secret fallback with NODE_ENV unset', () => {
    delete process.env.NODE_ENV
    process.env.KESTREL_DEV = '1'
    delete process.env.KESTREL_SESSION_SECRET
    delete process.env.KESTREL_SECURE_COOKIES
    expect(() => sessionSettings()).not.toThrow()
  })
})

describe('session epoch — hard logout revocation', () => {
  it('folding the epoch into the signing key kills a previously-signed token', () => {
    const key0 = deriveSigningKey('secret', undefined, 0)
    const key1 = deriveSigningKey('secret', undefined, 1)
    expect(key0).not.toBe(key1)
    const token = signSession(key0, now + 1000)
    expect(verifySession(key0, token, now).valid).toBe(true)  // valid under its epoch
    expect(verifySession(key1, token, now).valid).toBe(false) // dead after the epoch bump (logout)
  })

  it('bumpSessionEpoch increments + persists to the file, surviving a cache reset (restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-epoch-'))
    const file = join(dir, '.epoch')
    const saved = process.env.KESTREL_SESSION_EPOCH_FILE
    process.env.KESTREL_SESSION_EPOCH_FILE = file
    try {
      _resetSessionEpochCache()
      expect(currentSessionEpoch()).toBe(0) // absent file → baseline 0
      bumpSessionEpoch()
      expect(currentSessionEpoch()).toBe(1)
      expect(readFileSync(file, 'utf8').trim()).toBe('1') // persisted
      _resetSessionEpochCache() // simulate a process restart
      expect(currentSessionEpoch()).toBe(1) // re-read from the persisted file
    } finally {
      if (saved === undefined) delete process.env.KESTREL_SESSION_EPOCH_FILE
      else process.env.KESTREL_SESSION_EPOCH_FILE = saved
      _resetSessionEpochCache()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('deriveSigningKey (L4 revocation)', () => {
  it('differs when the password hash differs; is stable for the same inputs', () => {
    expect(deriveSigningKey('secret', 'hashA')).not.toBe(deriveSigningKey('secret', 'hashB'))
    expect(deriveSigningKey('secret', undefined)).toBe(deriveSigningKey('secret', undefined))
  })
  it('invalidates a token after the password hash changes', () => {
    const now = 1000
    const keyA = deriveSigningKey('secret', 'hashA')
    const keyB = deriveSigningKey('secret', 'hashB')
    const token = signSession(keyA, now + 10_000)
    expect(verifySession(keyA, token, now).valid).toBe(true)
    expect(verifySession(keyB, token, now).valid).toBe(false)
  })
})
