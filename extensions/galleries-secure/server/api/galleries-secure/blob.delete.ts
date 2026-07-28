// Delete one ciphertext blob from a gallery's namespace (so removing an image leaves no orphan — storage
// stays 1:1 with the index). Behind admin write + CSRF. The driver delete is idempotent.
export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop — never rely solely on the /api guard's path heuristic
  const body = await readBody(event)
  const ns = galleryNamespace(body?.galleryId)
  const blob = blobName(body?.blobId)
  await useStorageDriver().delete(`${ns}/${blob}`)
  return { ok: true }
})
