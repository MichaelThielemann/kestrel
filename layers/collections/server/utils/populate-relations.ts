import { fieldIs } from '../../../core/server/utils/defineCollection'
import type { FieldPopulator } from '../../../core/server/utils/populate'
import { memoDuringPrerender } from '../../../core/server/utils/prerender-memo'
import { memoResolver } from '../../../core/server/utils/resolve-scope'

/** Fetches a related record FULLY populated (its own media / links / nested relations resolved), or null
 *  when the id is stale / deleted / draft. Injected so the populator stays pure + unit-testable; the plugin
 *  wires the real `getOne`. `depth` is the ALREADY-decremented depth for the related read (the cycle guard). */
export type ResolveRecord = (
  collection: string,
  id: number,
  depth: number,
  locale: string,
) => Record<string, unknown> | null

/**
 * Run a related-record fetch, mapping `getOne`'s 404 (a stale / deleted / draft target — the intended
 * "skip this reference" signal) to `null`, but letting ANY OTHER error propagate. Swallowing every error
 * here would drop a relation on a real fault (a DB error, a downstream populator throwing on malformed
 * stored data) while the page still renders + records `success` — violating fail-loud. Pure + testable.
 */
export function skipMissing(fetch: () => Record<string, unknown>): Record<string, unknown> | null {
  try {
    return fetch()
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode === 404) return null
    throw e
  }
}

/**
 * The `relation` field populator: expands a relation id (single, `${name}Id` in columns / bare in props)
 * or id array (many, always bare) into the fully-populated related record(s) under a `$<name>` sibling,
 * leaving the raw id column intact — so write round-trips and the admin relation-picker keep working.
 * Stale / deleted / draft ids are skipped (single → null, many → filtered out) so one bad reference never
 * fails the whole read. The related read passes `ctx.depth - 1`; `populateRow` bails at depth 0, so a
 * relation cycle terminates. Registered per-type via `registerFieldPopulator('relation', …)`; the shared
 * field-tree walker drives it over top-level fields, block props, slots, and repeater entries.
 */
export function buildRelationFieldPopulator(resolveRecord: ResolveRecord): FieldPopulator {
  // The same target (collection+id+depth+locale) is resolved once — build-wide during a generate run
  // (memoDuringPrerender), request-/publish-run-wide via the resolve scope (which also budgets the
  // distinct fan-out of one live request and replays read-tags on hits, so publish deps stay complete).
  // memoResolver OUTERMOST: the per-scope budget verdict must stay scope-local. If memoDuringPrerender
  // wrapped memoResolver, a build-wide memoize would cache a budget-skip `null` and poison every later
  // page of a `nuxt generate`. With this order the build-wide memo only ever caches REAL resolver results.
  const key = (collection: string, id: number, depth: number, locale: string) => `rel:${collection}:${id}:${depth}:${locale}`
  const resolve = memoResolver(memoDuringPrerender(resolveRecord, key), key)
  return (bag, key, field, ctx, keyMode) => {
    if (!fieldIs(field, 'relation')) return
    const collection = field.relation.collection
    const depth = ctx.depth - 1
    if (field.relation.many) {
      const ids = bag[key]
      if (Array.isArray(ids)) {
        bag['$' + key] = ids
          .filter((n): n is number => typeof n === 'number')
          .map((id) => resolve(collection, id, depth, ctx.locale))
          .filter((r): r is Record<string, unknown> => r != null)
      }
    } else {
      const id = bag[keyMode === 'columns' ? `${key}Id` : key]
      if (typeof id === 'number') bag['$' + key] = resolve(collection, id, depth, ctx.locale)
    }
  }
}
