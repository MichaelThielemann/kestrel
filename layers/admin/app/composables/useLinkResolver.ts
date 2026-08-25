import { reactive } from 'vue'

/**
 * Batched, cached client resolution of internal-link refs (`{collection, id}`) → public href,
 * mirroring the server `resolveInternalHref` so the live preview's `KestrelLink` renders real internal
 * paths instead of `'#'`. Per instance (no shared module state → SSR-safe). No locale param: an
 * internal link points to one specific record, whose href is its own locale's path. Misses are cached
 * (empty string) so a dangling (missing-target) ref isn't re-fetched on every preview recompute.
 */
export function useLinkResolver() {
  const cache = reactive(new Map<string, string>())
  const pending = new Set<string>()
  const keyFor = (collection: string, id: number) => `${collection}:${id}`

  async function ensure(refs: { collection: string; id: number }[]): Promise<void> {
    const missing = refs.filter((r) =>
      !!r.collection && Number.isInteger(r.id) && r.id > 0
      && !cache.has(keyFor(r.collection, r.id)) && !pending.has(keyFor(r.collection, r.id)))
    if (!missing.length) return
    const keys = missing.map((r) => keyFor(r.collection, r.id))
    for (const k of keys) pending.add(k)
    try {
      const { data } = await $fetch<{ data: { collection: string; id: number; href: string }[] }>(
        '/api/resolveLinks', { query: { refs: keys.join(',') } },
      )
      const got = new Map(data.map((d) => [keyFor(d.collection, d.id), d.href]))
      for (const k of keys) cache.set(k, got.get(k) ?? '') // cache misses too, as '' → no re-fetch
    } catch {
      // leave unresolved — the preview shows '#' for these until a later attempt
    } finally {
      for (const k of keys) pending.delete(k)
    }
  }

  function resolve(collection: string, id: number): string | null {
    return cache.get(keyFor(collection, id)) || null
  }

  return { cache, ensure, resolve }
}
