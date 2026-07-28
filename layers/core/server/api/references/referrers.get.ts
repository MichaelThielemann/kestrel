import { MAX_BULK_IDS } from '../../../app/utils/list-limits'

// The distinct records that reference a given target — the reverse "what links here" lookup. Admin-only
// (the `references` resource is not in the public set). Powers the editor's pre-delete referrer warning.
// Two arms:
//   ?collection=X&id=1        -> FieldRef[]                    (single target; the editor's warning)
//   ?collection=X&ids=1,2,3   -> { counts: Record<id, count>, checked: boolean }  (a selection; the bulk-delete warning)
// `checked` is false when the lookup itself failed (e.g. record_refs not migrated yet) — an empty `counts`
// then means "could not check", NOT "no referrers", so a caller must not read it as a green light to delete.
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const collection = String(q.collection ?? '')
  if (q.ids != null) {
    if (!collection) throw createError({ statusCode: 400, statusMessage: 'collection and ids query params are required' })
    const ids = parseIdList(q.ids, MAX_BULK_IDS)
    const counts = findReferrersForMany(useDb(), collection, ids)
    return { counts: counts ?? {}, checked: counts !== null }
  }
  const id = Number(q.id)
  if (!collection || !Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'collection and id query params are required' })
  }
  return findReferrers(useDb(), collection, id) ?? []
})
