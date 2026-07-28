import { registerFieldPopulator } from '../../../core/server/utils/populate'
import { buildRelationFieldPopulator, skipMissing } from '../utils/populate-relations'
import { getCollection } from '../../../core/server/utils/registry'
import { getOne } from '../../../core/server/utils/crud'

// Expand relation fields to the fully-populated related record(s) under `$<name>` at read time (depth ≥ 1).
// The related read is published-only (a draft target is skipped, never leaked to a public read), tolerates a
// stale/deleted id (getOne 404 → null via `skipMissing`, other errors propagate — fail-loud), and runs at
// `depth - 1`, so `populateRow` bails at 0 and cycles terminate. Registered per-type; the shared field-tree
// walker (fields layer) dispatches it.
export default defineNitroPlugin(() => {
  registerFieldPopulator('relation', buildRelationFieldPopulator((collection, id, depth, locale) => {
    const built = getCollection(collection)
    if (!built) return null
    return skipMissing(() => getOne(useDb(), built, id, depth, locale, true) as Record<string, unknown>)
  }))
})
