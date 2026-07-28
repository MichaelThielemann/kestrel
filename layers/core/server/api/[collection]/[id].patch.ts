export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const collection = requireCollection(event)
  const id = requireId(event)
  const body = await readBody(event)
  // Optimistic concurrency: the editor sends the baseline it loaded; a stale save is refused with 409.
  return update(useDb(), collection, id, body, { expectedUpdatedAt: readIfUnmodifiedSince(event) })
})
