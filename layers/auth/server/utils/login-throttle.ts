import { createError } from 'h3'

export const MAX_LOGIN_BODY = 4096
export const MAX_INFLIGHT_HASHES = 4

export function assertBodyLimit(contentLength: string | undefined, maxBytes = MAX_LOGIN_BODY): void {
  const len = Number(contentLength)
  // A missing/garbage Content-Length means a chunked transfer, which readBody would buffer with no
  // ceiling — refuse it. The only legitimate login body is a tiny JSON object with a known length.
  if (contentLength === undefined || !Number.isFinite(len) || len < 0) {
    throw createError({ statusCode: 411, statusMessage: 'Length required' })
  }
  if (len > maxBytes) {
    throw createError({ statusCode: 413, statusMessage: 'Payload too large' })
  }
}

export const MAX_LOGIN_FAILS = 10
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
// Hard ceiling on the number of distinct IPs tracked at once. A login POST is anonymously reachable and
// seeds an entry BEFORE the expensive scrypt runs, so without a bound a spray from many distinct source
// addresses (e.g. a routed IPv6 /64 or a botnet) could grow this map without limit and OOM the process.
// Generous vs any real login volume for a single-admin CMS; eviction (below) keeps memory bounded.
export const MAX_TRACKED_IPS = 10_000

// Per-IP failed-attempt timestamps (in-memory, per-process: resets on restart, fine for a
// single-instance private CMS). Bounds online brute-force; the admin password entropy is the
// primary defense. The keying IP comes from `clientIp` (socket peer by default; trusted
// X-Forwarded-For hop only when KESTREL_TRUST_PROXY is set). Bounded by MAX_TRACKED_IPS + eviction.
const loginFails = new Map<string, number[]>()

function recentFails(ip: string, nowMs: number): number[] {
  const fresh = (loginFails.get(ip) ?? []).filter((t) => nowMs - t < LOGIN_WINDOW_MS)
  // DELETE rather than persist an empty array: an IP whose failures have all aged out (or that only ever
  // hit the read-path lockout check) must not leave a permanent entry — otherwise a distinct-IP flood of
  // one-shot addresses grows the map forever (every key would be reclaimed only by a *successful* login).
  if (fresh.length === 0) loginFails.delete(ip)
  else loginFails.set(ip, fresh)
  return fresh
}

/** Reclaim every entry whose newest failure has aged past the window (a cheap sweep run under pressure). */
function evictExpired(nowMs: number): void {
  for (const [ip, times] of loginFails) {
    const newest = times[times.length - 1]
    if (newest === undefined || nowMs - newest >= LOGIN_WINDOW_MS) loginFails.delete(ip)
  }
}

export function assertNotLockedOut(ip: string, nowMs: number): void {
  if (recentFails(ip, nowMs).length >= MAX_LOGIN_FAILS) {
    throw createError({ statusCode: 429, statusMessage: 'Too many attempts, try again later' })
  }
}

export function recordFailedLogin(ip: string, nowMs: number): void {
  const fails = recentFails(ip, nowMs)
  fails.push(nowMs)
  loginFails.set(ip, fails)
  // Enforce the ceiling: first reclaim anything already expired, then, if still over budget, evict the
  // oldest-inserted entries (Map preserves insertion order → FIFO). Evicting a live entry merely resets that
  // IP's throttle — acceptable under memory pressure; the primary brute-force defense is password entropy.
  if (loginFails.size > MAX_TRACKED_IPS) {
    evictExpired(nowMs)
    while (loginFails.size > MAX_TRACKED_IPS) {
      const oldest = loginFails.keys().next().value
      if (oldest === undefined) break
      loginFails.delete(oldest)
    }
  }
}

export function clearLoginFailures(ip: string): void {
  loginFails.delete(ip)
}

/** Test/introspection helpers: current tracked-IP count and a full reset (the store is a module singleton). */
export function loginFailIpCount(): number {
  return loginFails.size
}
export function clearAllLoginFailures(): void {
  loginFails.clear()
}

/**
 * Atomically reserve a login attempt: assert the IP isn't locked out AND record the attempt in one
 * synchronous step (no await between the check and the record). This makes the throttle a true
 * reservation — concurrent in-flight guesses, each awaiting a slow scrypt verify, all count toward the
 * cap up front, instead of every one passing the gate on the same pre-increment count. The handler
 * clears the reservation on a successful login; a failed login leaves it recorded.
 */
export function reserveLoginAttempt(ip: string, nowMs: number): void {
  assertNotLockedOut(ip, nowMs)
  recordFailedLogin(ip, nowMs)
}

/**
 * Undo a `reserveLoginAttempt` reservation for an outage no caller could have caused or guessed past (no
 * admin hash configured) — otherwise a misconfigured deployment leaves the admin throttled once they fix
 * it. Deliberately NOT used for attacker-triggerable rejections: charging those is what makes a flood run
 * into the lockout. Removes one entry equal to `nowMs` (there is at most one per call, recorded
 * synchronously by the reservation this undoes; entries are interchangeable by value, so it doesn't
 * matter which one a concurrent same-millisecond request added).
 */
export function releaseLoginAttempt(ip: string, nowMs: number): void {
  const fails = loginFails.get(ip)
  if (!fails) return
  const idx = fails.lastIndexOf(nowMs)
  if (idx === -1) return
  fails.splice(idx, 1)
  if (fails.length === 0) loginFails.delete(ip)
  else loginFails.set(ip, fails)
}

let inFlight = 0

export function acquireHashSlot(): void {
  if (inFlight >= MAX_INFLIGHT_HASHES) {
    throw createError({ statusCode: 503, statusMessage: 'Busy, try again' })
  }
  inFlight++
}

export function releaseHashSlot(): void {
  if (inFlight > 0) inFlight--
}
