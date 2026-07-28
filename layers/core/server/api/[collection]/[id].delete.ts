export default defineEventHandler((event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const collection = requireCollection(event)
  return remove(useDb(), collection, requireId(event))
})
