/** Memoize a resolver by a string key. The cache lives for the returned function's lifetime, so only
 *  use it where the underlying data is immutable for that lifetime. Caches misses (null/undefined) too. */
export function memoize<A extends unknown[], R>(fn: (...args: A) => R, key: (...args: A) => string): (...args: A) => R {
  const cache = new Map<string, R>()
  return (...args: A): R => {
    const k = key(...args)
    if (cache.has(k)) return cache.get(k) as R
    const value = fn(...args)
    cache.set(k, value)
    return value
  }
}

/**
 * Like `memoize`, but active ONLY during a `nuxt generate` prerender run (`import.meta.prerender`), where
 * the DB is read-only for the whole build and a referenced media asset / link target is identical across
 * every page that embeds it — so a shared header image reused on 100 pages is resolved once, not 100×.
 * Outside prerender (dev SSR, tests) it returns the resolver untouched, so a live edit is never served
 * stale and there is no cross-request cache to invalidate.
 */
export function memoDuringPrerender<A extends unknown[], R>(fn: (...args: A) => R, key: (...args: A) => string): (...args: A) => R {
  return (import.meta as { prerender?: boolean }).prerender ? memoize(fn, key) : fn
}
