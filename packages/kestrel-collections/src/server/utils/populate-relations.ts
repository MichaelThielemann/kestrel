import { fieldIs, memoDuringPrerender, memoResolver } from '@kestrel/core'
import type { FieldPopulator } from '@kestrel/core'
/** Fetches a related record FULLY populated (its own media / links / nested relations resolved), or null
 *  when the id is stale / deleted / draft. Injected so the populator stays pure + unit-testable; the plugin
 *  wires the real `getOne`. `depth` is the ALREADY-decremented depth for the related read (the cycle guard).
 * @public
 */
export type ResolveRecord = (
  collection: string,
  id: number,
  depth: number,
  locale: string,
  publicOnly: boolean,
) => Record<string, unknown> | null

/**
 * Run a related-record fetch, mapping `getOne`'s 404 (a stale / deleted / draft target — the intended
 * "skip this reference" signal) to `null`, but letting ANY OTHER error propagate. Swallowing every error
 * here would drop a relation on a real fault (a DB error, a downstream populator throwing on malformed
 * stored data) while the page still renders + records `success` — violating fail-loud. Pure + testable.
 * @public
 */
export function skipMissing(fetch: () => Record<string, unknown>): Record<string, unknown> | null {
  try {
    return fetch()
  } catch (e) {
    const err = e as { _tag?: string }
    if (err?._tag === 'NotFound') return null
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
 *
 * Under `ctx.publicOnly` a relation into a collection `isPublicCollection` rejects is left unexpanded
 * (raw id only, NO `$<name>` sibling at all — a relation field targets exactly one collection, so a
 * `many` relation is all-or-nothing): expansion must not reach a record the caller could not have
 * requested directly. The check runs BEFORE `resolve`, so a withheld target never enters the memo.
 * @public
 */
export function buildRelationFieldPopulator(
  resolveRecord: ResolveRecord,
  isPublicCollection: (collection: string) => boolean,
): FieldPopulator {
  // The same target (collection+id+depth+locale+scope) is resolved once — build-wide during a generate run
  // (memoDuringPrerender), request-/publish-run-wide via the resolve scope (which also budgets the
  // distinct fan-out of one live request and replays read-tags on hits, so publish deps stay complete).
  // memoResolver OUTERMOST: the per-scope budget verdict must stay scope-local. If memoDuringPrerender
  // wrapped memoResolver, a build-wide memoize would cache a budget-skip `null` and poison every later
  // page of a `nuxt generate`. With this order the build-wide memo only ever caches REAL resolver results.
  // `publicOnly` is part of the key because the same record populates DIFFERENTLY under it (its own
  // non-public relations are withheld) — sharing one entry would serve one scope's record to the other.
  const key = (collection: string, id: number, depth: number, locale: string, publicOnly: boolean) => `rel:${collection}:${id}:${depth}:${locale}:${publicOnly}`
  const resolve = memoResolver(memoDuringPrerender(resolveRecord, key), key)
  return (bag, key, field, ctx, keyMode) => {
    if (!fieldIs(field, 'relation')) return
    const collection = field.relation.collection
    const publicOnly = ctx.publicOnly === true
    if (publicOnly && !isPublicCollection(collection)) return
    const depth = ctx.depth - 1
    if (field.relation.many) {
      const ids = bag[key]
      if (Array.isArray(ids)) {
        bag['$' + key] = ids
          .filter((n): n is number => typeof n === 'number')
          .map((id) => resolve(collection, id, depth, ctx.locale, publicOnly))
          .filter((r): r is Record<string, unknown> => r != null)
      }
    } else {
      const id = bag[keyMode === 'columns' ? `${key}Id` : key]
      if (typeof id === 'number') bag['$' + key] = resolve(collection, id, depth, ctx.locale, publicOnly)
    }
  }
}
