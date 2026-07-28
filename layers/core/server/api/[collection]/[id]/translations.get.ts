export default defineEventHandler((event) => {
  const collection = requireCollection(event)
  return resolveTranslations(useDb(), collection, requireId(event))
})
