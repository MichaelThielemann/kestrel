import type { Invalidation } from './invalidation.js'

/**
 * Merge a burst of invalidations collected during a debounce window into one: any `full` wins (a
 * full rebuild subsumes everything); otherwise union the `tags`/`render`/`prune` sets (dedup, stable
 * insertion order); all-`noop` (or empty) collapses to `noop`.
 * @public
 */
export function coalesce(items: Invalidation[]): Invalidation {
  if (items.some((i) => i.type === 'full')) return { type: 'full' }
  const tags = new Set<string>()
  const render = new Set<string>()
  const prune = new Set<string>()
  let any = false
  for (const i of items) {
    if (i.type !== 'tags') continue
    any = true
    for (const t of i.tags) tags.add(t)
    for (const r of i.render) render.add(r)
    for (const p of i.prune) prune.add(p)
  }
  return any ? { type: 'tags', tags: [...tags], render: [...render], prune: [...prune] } : { type: 'noop' }
}
