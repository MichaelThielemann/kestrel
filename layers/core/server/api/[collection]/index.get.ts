export default defineEventHandler((event) => {
  const collection = requireCollection(event)
  const query = getQuery(event)
  const db = useDb()
  const publishedOnly = publishedOnlyForScope(event.context.readScope)
  // Keyed on the ROLE, not the read scope: the renderer reads published-only too, but it produces the
  // static site and must still see every relation the output embeds. Only a visitor the guard scopes to
  // the public collection set is barred from reaching further through a populated relation. Fail-CLOSED
  // on a missing principal, like `publishedOnlyForScope` above — an absent one is a guard regression.
  const publicOnly = (event.context.principal?.role ?? 'anonymous') === 'anonymous'

  if (collection.def.mode === 'single') {
    return getSingleton(db, collection, query.locale as string | undefined, publishedOnly, query.depth ? Number(query.depth) : 0, publicOnly)
  }

  return list(db, collection, {
    locale: query.locale as string | undefined,
    sort: query.sort as string | undefined,
    page: query.page ? Number(query.page) : undefined,
    perPage: query.perPage ? Number(query.perPage) : undefined,
    filter: parseFilter(query as Record<string, unknown>),
    depth: query.depth ? Number(query.depth) : 0,
  }, publishedOnly, publicOnly)
})
