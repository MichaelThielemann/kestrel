import { AsyncLocalStorage } from 'node:async_hooks'
import { withReadCaptureSync, replayReadTags } from './read-capture.js'

/**
 * Per-request/per-run resolver memoization + fan-out budget. `memoDuringPrerender` only dedupes during a
 * `nuxt generate` build; a LIVE request re-resolved every repeated reference, so an anonymous
 * `?depth=10&perPage=500` read could multiply into a huge number of synchronous DB reads (each blocking
 * the single event-loop thread). A scope gives the populate resolvers (relation/media/link):
 *   - a shared cache: each distinct target is resolved ONCE per scope (repeated refs are free), and
 *   - a budget on DISTINCT resolves: past it, further NEW targets resolve to null — the same degrade
 *     path as a stale reference — bounding the worst-case work of one request.
 * Nested scopes reuse the outermost one (a relation's recursive getOne inherits the request's scope; the
 * runtime publisher wraps a whole run in an UNBUDGETED scope, giving it the per-run dedup a generate
 * build gets from `memoDuringPrerender`). Outside any scope a resolver runs raw — no cross-request cache.
 */
interface CacheEntry {
  value: unknown
  /** The read-tags the resolver captured while producing `value` — replayed on every hit, so a page
   *  served from the memo still records the SAME publish deps as the page that resolved it. */
  tags: string[]
}

interface ResolveScope {
  cache: Map<string, CacheEntry>
  max: number
  used: number
  tripped: boolean
  label: string
}

const storage = new AsyncLocalStorage<ResolveScope>()

/** Per-request distinct-resolve ceiling. Sized so a LEGITIMATE full page never trips it — the dominant
 *  protection is the per-scope dedup (distinct resolves are bounded by the referenced record set, not the
 *  breadth^depth fan-out), so this is only a backstop against a pathologically dense reference graph.
 *  `resolveBudgetFor(perPage)` scales it with the page size so a `perPage=500, depth≥1` read of richly-
 * @public
 *  referenced rows still populates every row. */
export const REQUEST_RESOLVE_BUDGET = 20_000
/** @public */
export function resolveBudgetFor(perPage?: number): number {
  const scaled = (perPage && perPage > 0 ? perPage : 1) * 200 // ~200 distinct refs/row headroom
  return Math.max(REQUEST_RESOLVE_BUDGET, scaled)
}

/** @public */
export function withResolveScope<T>(fn: () => T, max = Number.POSITIVE_INFINITY, label = 'read'): T {
  if (storage.getStore()) return fn() // nested — the outermost scope owns cache + budget
  return storage.run({ cache: new Map(), max, used: 0, tripped: false, label }, fn)
}

/** Wrap a resolver: inside a scope it memoizes by `key` and enforces the scope's budget (over-budget new
 * @public
 *  targets → null); outside a scope it calls through untouched. */
export function memoResolver<A extends unknown[], R>(
  fn: (...args: A) => R,
  key: (...args: A) => string,
): (...args: A) => R | null {
  return (...args: A): R | null => {
    const scope = storage.getStore()
    if (!scope) return fn(...args)
    const k = key(...args)
    const hit = scope.cache.get(k)
    if (hit) {
      replayReadTags(hit.tags)
      return hit.value as R
    }
    if (scope.used >= scope.max) {
      // Over budget: skip (like a stale ref) but make it OBSERVABLE — a legitimate large read silently
      // dropping `$media`/`$relation` would otherwise be invisible. Warn ONCE per scope.
      if (!scope.tripped) {
        scope.tripped = true
        console.warn(`[kestrel] resolve budget (${scope.max}) exceeded during "${scope.label}" — some references were left unpopulated. Reduce perPage/depth or raise the budget.`)
      }
      return null
    }
    scope.used++
    const { result, tags } = withReadCaptureSync(() => fn(...args))
    replayReadTags(tags) // the miss's own render must record them too (the sync capture is isolating)
    scope.cache.set(k, { value: result, tags })
    return result
  }
}
