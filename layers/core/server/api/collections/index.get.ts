export default defineEventHandler(() => {
  return { data: allCollections().map((c) => serializeCollection(c.def)) }
})
