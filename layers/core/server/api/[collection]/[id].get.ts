export default defineEventHandler((event) => {
  const collection = requireCollection(event)
  const query = getQuery(event)
  const depth = Number(query.depth ?? 0)
  const locale = query.locale as string | undefined
  const publishedOnly = publishedOnlyForScope(event.context.readScope)
  return getOne(useDb(), collection, requireId(event), depth, locale, publishedOnly)
})
