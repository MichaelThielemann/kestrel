import { getCollection, getOne, registerFieldPopulator, useDb } from '@kestrel/core'
import { isPubliclyReadable, publicReadableResources } from '@kestrel/access'
import { buildRelationFieldPopulator, skipMissing } from '@kestrel/collections'
// Expand relation fields to the fully-populated related record(s) under `$<name>` at read time (depth ≥ 1).
// The related read is published-only (a draft target is skipped, never leaked to a public read), tolerates a
// stale/deleted id (getOne 404 → null via `skipMissing`, other errors propagate — fail-loud), and runs at
// `depth - 1`, so `populateRow` bails at 0 and cycles terminate. Registered per-type; the shared field-tree
// walker (fields layer) dispatches it.
// The reachability predicate is the declared public set, NOT the guard's full decision — the guard also
// folds in `registeredGrants()`, which this omits. So a collection opened to anonymous by a registered
// grant is served on its own route but stays unexpanded here: fail-closed drift, never a widening.
export default defineNitroPlugin(() => {
  registerFieldPopulator('relation', buildRelationFieldPopulator((collection, id, depth, locale, publicOnly) => {
    const built = getCollection(collection)
    if (!built) return null
    return skipMissing(() => getOne(useDb(), built, id, depth, locale, true, publicOnly) as Record<string, unknown>)
  }, (collection) => isPubliclyReadable(collection, publicReadableResources())))
})
