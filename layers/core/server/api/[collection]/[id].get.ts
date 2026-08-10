export default defineEventHandler((event) => {
  const collection = requireCollection(event)
  const query = getQuery(event)
  const depth = Number(query.depth ?? 0)
  const locale = query.locale as string | undefined
  const publishedOnly = publishedOnlyForScope(event.context.readScope)
  // See index.get.ts: the public-set restriction follows the ROLE, so the renderer keeps full population;
  // a missing principal fails closed onto it.
  const publicOnly = (event.context.principal?.role ?? 'anonymous') === 'anonymous'
  return getOne(useDb(), collection, requireId(event), depth, locale, publishedOnly, publicOnly)
})
