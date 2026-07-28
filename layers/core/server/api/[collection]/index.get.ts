export default defineEventHandler((event) => {
  const collection = requireCollection(event)
  const query = getQuery(event)
  const db = useDb()
  const publishedOnly = publishedOnlyForScope(event.context.readScope)

  if (collection.def.mode === 'single') {
    return getSingleton(db, collection, query.locale as string | undefined, publishedOnly, query.depth ? Number(query.depth) : 0)
  }

  return list(db, collection, {
    locale: query.locale as string | undefined,
    sort: query.sort as string | undefined,
    page: query.page ? Number(query.page) : undefined,
    perPage: query.perPage ? Number(query.perPage) : undefined,
    filter: parseFilter(query as Record<string, unknown>),
    depth: query.depth ? Number(query.depth) : 0,
  }, publishedOnly)
})
