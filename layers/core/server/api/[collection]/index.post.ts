export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const collection = requireCollection(event)
  const body = await readBody(event)
  const row = create(useDb(), collection, body)
  setResponseStatus(event, 201)
  return row
})
