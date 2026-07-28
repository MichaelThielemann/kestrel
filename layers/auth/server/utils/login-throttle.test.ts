import { describe, it, expect, beforeEach } from 'vitest'
import {
  assertBodyLimit, acquireHashSlot, releaseHashSlot, MAX_INFLIGHT_HASHES, MAX_LOGIN_BODY,
  assertNotLockedOut, recordFailedLogin, clearLoginFailures, reserveLoginAttempt, releaseLoginAttempt,
  MAX_LOGIN_FAILS, LOGIN_WINDOW_MS, MAX_TRACKED_IPS, loginFailIpCount, clearAllLoginFailures,
} from './login-throttle'

describe('login-throttle', () => {
  it('assertBodyLimit throws 413 over the limit, 411 when length is absent/non-numeric, passes otherwise', () => {
    expect(() => assertBodyLimit(String(MAX_LOGIN_BODY + 1))).toThrowError(/too large/i)
    expect(() => assertBodyLimit('100')).not.toThrow()
    // Absent length == chunked transfer == unbounded buffering: refuse rather than read.
    expect(() => assertBodyLimit(undefined)).toThrowError(/length required/i)
    expect(() => assertBodyLimit('not-a-number')).toThrowError(/length required/i)
  })
  it('locks out an IP after too many recent failed logins (sliding window)', () => {
    const ip = '203.0.113.5'
    const t0 = 1_000_000
    for (let i = 0; i < MAX_LOGIN_FAILS; i++) {
      expect(() => assertNotLockedOut(ip, t0 + i)).not.toThrow()
      recordFailedLogin(ip, t0 + i)
    }
    expect(() => assertNotLockedOut(ip, t0 + MAX_LOGIN_FAILS)).toThrowError(/too many/i)
    // once the window slides past, the stale failures expire and access is allowed again
    expect(() => assertNotLockedOut(ip, t0 + LOGIN_WINDOW_MS + 1)).not.toThrow()
    clearLoginFailures(ip)
  })

  it('reserveLoginAttempt counts each in-flight attempt immediately (closes the check-then-act race)', () => {
    const ip = '203.0.113.7'
    const t0 = 9_000_000
    // Reserve up to the cap WITHOUT any attempt "completing" (recordFailedLogin happens up-front, before
    // the slow hash). The (cap+1)th reservation must already be locked out — concurrent in-flight guesses
    // can no longer all pass the gate before any records its failure.
    for (let i = 0; i < MAX_LOGIN_FAILS; i++) expect(() => reserveLoginAttempt(ip, t0 + i)).not.toThrow()
    expect(() => reserveLoginAttempt(ip, t0 + MAX_LOGIN_FAILS)).toThrowError(/too many/i)
    clearLoginFailures(ip)
  })

  it('a successful login (clearLoginFailures) resets the counter', () => {
    const ip = '203.0.113.9'
    const t0 = 5_000_000
    for (let i = 0; i < MAX_LOGIN_FAILS; i++) recordFailedLogin(ip, t0 + i)
    clearLoginFailures(ip)
    expect(() => assertNotLockedOut(ip, t0 + MAX_LOGIN_FAILS)).not.toThrow()
  })

  it('tracks IPs independently', () => {
    const t0 = 9_000_000
    for (let i = 0; i < MAX_LOGIN_FAILS; i++) recordFailedLogin('10.0.0.1', t0 + i)
    expect(() => assertNotLockedOut('10.0.0.1', t0 + MAX_LOGIN_FAILS)).toThrowError(/too many/i)
    expect(() => assertNotLockedOut('10.0.0.2', t0 + MAX_LOGIN_FAILS)).not.toThrow()
    clearLoginFailures('10.0.0.1')
  })

  it('hash-slot cap allows up to MAX concurrent and rejects beyond, then frees', () => {
    for (let i = 0; i < MAX_INFLIGHT_HASHES; i++) acquireHashSlot()
    expect(() => acquireHashSlot()).toThrowError(/Busy/)
    releaseHashSlot()
    expect(() => acquireHashSlot()).not.toThrow()
    for (let i = 0; i < MAX_INFLIGHT_HASHES; i++) releaseHashSlot()
  })

  it('releaseLoginAttempt undoes a reservation that never evaluated a credential', () => {
    const ip = '203.0.113.11'
    const t0 = 1_000_000
    reserveLoginAttempt(ip, t0)
    releaseLoginAttempt(ip, t0)
    expect(loginFailIpCount()).toBe(0)
    expect(() => assertNotLockedOut(ip, t0)).not.toThrow()
  })

  it('releaseLoginAttempt leaves other recorded failures for the same IP intact', () => {
    const ip = '203.0.113.12'
    const t0 = 2_000_000
    recordFailedLogin(ip, t0) // an evaluated, genuine failure
    reserveLoginAttempt(ip, t0 + 1) // a second attempt whose credential check never ran
    releaseLoginAttempt(ip, t0 + 1)
    // only the un-evaluated reservation is undone; the genuine failure still counts
    for (let i = 0; i < MAX_LOGIN_FAILS - 1; i++) recordFailedLogin(ip, t0 + 2 + i)
    expect(() => assertNotLockedOut(ip, t0 + 2 + MAX_LOGIN_FAILS)).toThrowError(/too many/i)
    clearLoginFailures(ip)
  })

  it('releaseLoginAttempt is a no-op for an IP with no recorded attempts', () => {
    expect(() => releaseLoginAttempt('203.0.113.13', 3_000_000)).not.toThrow()
  })
})

describe('login-throttle store bounds (distinct-IP flood safety)', () => {
  beforeEach(clearAllLoginFailures)

  it('drops an IP entry once its failures age out, instead of retaining an empty array', () => {
    const ip = '198.51.100.7'
    const t0 = 2_000_000
    recordFailedLogin(ip, t0)
    expect(loginFailIpCount()).toBe(1)
    // A read-path check after the window has slid past must reclaim the entry (an IP that never returns
    // otherwise leaves a permanent record → unbounded growth under a distinct-IP spray).
    expect(() => assertNotLockedOut(ip, t0 + LOGIN_WINDOW_MS + 1)).not.toThrow()
    expect(loginFailIpCount()).toBe(0)
  })

  it('caps the tracked-IP map so a distinct-IP flood cannot exhaust memory', () => {
    const t0 = 3_000_000
    // Seed far more distinct IPs than the cap, all within the window (so none expire on their own).
    for (let i = 0; i < MAX_TRACKED_IPS + 500; i++) recordFailedLogin(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, t0)
    expect(loginFailIpCount()).toBeLessThanOrEqual(MAX_TRACKED_IPS)
  })
})
