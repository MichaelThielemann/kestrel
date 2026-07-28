export default defineEventHandler((event) => {
  const collection = getCollectionOr404(getRouterParam(event, 'name') as string)
  return serializeCollection(collection.def)
})
