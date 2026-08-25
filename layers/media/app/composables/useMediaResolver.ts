import { reactive, toValue } from 'vue'
import type { MaybeRefOrGetter } from 'vue'
import type { ResolvedMedia } from '@kestrel/media'

// The client-facing resolved-media shape (`GET /api/media/resolve`) is the server resolver's own
// return type — re-exported so consumers keep importing it from here, single-sourced so it can't drift.
export type { ResolvedMedia }

/**
 * Batched, cached client resolution of media ids → `ResolvedMedia`. A reactive cache so callers can
 * `resolve(id)` inside a computed and have it re-evaluate once `ensure()` fills the cache. Per
 * instance (no shared module state → SSR-safe). The cache is keyed per locale, and `locale` may be
 * a ref/getter — a locale change makes its ids "missing" again so `ensure()` re-fetches and
 * `resolve()` returns the new-locale entry (translations differ per locale).
 */
export function useMediaResolver(locale?: MaybeRefOrGetter<string>) {
  const cache = reactive(new Map<string, ResolvedMedia>())
  // Keys that resolved to NOTHING (deleted/dangling id). Without this, a missing id is "missing" forever and
  // re-requested on every ensure(); the negative cache stops re-fetching it. Keyed per (locale, id) like the
  // positive cache, so a locale change still re-resolves. Only populated on a SUCCESSFUL fetch that omitted
  // the id — a network error leaves the id retryable.
  const absent = new Set<string>()
  const pending = new Set<string>()
  const loc = () => toValue(locale) || 'en'
  const keyFor = (l: string, id: number) => `${l}:${id}`

  async function ensure(ids: number[]): Promise<void> {
    const l = loc()
    const missing = ids.filter((id) => Number.isInteger(id) && id > 0 && !cache.has(keyFor(l, id)) && !absent.has(keyFor(l, id)) && !pending.has(keyFor(l, id)))
    if (!missing.length) return
    for (const id of missing) pending.add(keyFor(l, id))
    try {
      const { data } = await $fetch<{ data: ResolvedMedia[] }>('/api/media/resolve', { query: { ids: missing.join(','), locale: l } })
      const returned = new Set<number>()
      for (const m of data) { cache.set(keyFor(l, m.id), m); returned.add(m.id) }
      // A requested id the server didn't return is gone → remember it so we don't keep asking.
      for (const id of missing) if (!returned.has(id)) absent.add(keyFor(l, id))
    } catch {
      // leave unresolved (NOT absent) — a transient error stays retryable on a later attempt
    } finally {
      for (const id of missing) pending.delete(keyFor(l, id))
    }
  }

  function resolve(id: number): ResolvedMedia | null {
    return cache.get(keyFor(loc(), id)) ?? null
  }

  return { cache, ensure, resolve }
}
