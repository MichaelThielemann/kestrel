import { MAX_BULK_IDS } from '../../../app/utils/list-limits'

export default defineEventHandler((event) => {
  const collection = requireCollection(event)
  const query = getQuery(event)
  const db = useDb()

  return pickerOptions(db, collection, {
    search: query.search ? String(query.search) : undefined,
    ids: query.ids ? parseIdList(query.ids, MAX_BULK_IDS) : undefined,
    label: query.label ? String(query.label) : undefined,
    page: query.page ? Number(query.page) : undefined,
    perPage: query.perPage ? Number(query.perPage) : undefined,
    locale: query.locale ? String(query.locale) : undefined,
    // Match list()/getOne(): a published-scope read (anonymous / SSG) must not surface draft labels.
    publishedOnly: publishedOnlyForScope(event.context.readScope),
  })
})
