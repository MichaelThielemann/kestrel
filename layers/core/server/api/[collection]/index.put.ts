export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const collection = requireCollection(event)
  const query = getQuery(event)
  const body = await readBody(event)
  return putSingleton(useDb(), collection, query.locale as string | undefined, body, { expectedUpdatedAt: readIfUnmodifiedSince(event) })
})
