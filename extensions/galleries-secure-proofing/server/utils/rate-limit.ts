// Best-effort in-memory fixed-window rate limit for the public proofing back-channel. Generic over the caller-
// supplied `key`: the submit route uses the bare IP for the volume limit and an `newcust:<ip>:<slug>` key for
// the per-IP-per-slug new-identity budget. Single-instance only (state is a module Map: resets on restart, not
// shared across instances) — adequate for the photographer's single-server deployment; swap for a durable store
// if scaled. `now` is injected so the window logic is pure + node-testable.
interface Window { count: number; resetAt: number }
const windows = new Map<string, Window>()

/** Returns true if the request is within the limit for `key`; false if it should be throttled. */
export function rateLimit(key: string, now: number, limit = 30, windowMs = 60_000): boolean {
  const w = windows.get(key)
  if (!w || now >= w.resetAt) {
    // Opening a fresh window is the moment to sweep expired ones, so a public endpoint hit by rotating IPs
    // can't grow the map unbounded — it stays ~the count of currently-active windows.
    for (const [k, win] of windows) if (now >= win.resetAt) windows.delete(k)
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (w.count >= limit) return false
  w.count++
  return true
}

/** Test helper: drop all windows (the limiter is a module singleton). */
export function clearRateLimits(): void {
  windows.clear()
}

/** Test helper: current number of tracked windows (to assert eviction bounds the map). */
export function rateLimitWindowCount(): number {
  return windows.size
}
