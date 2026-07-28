// Recursively delete a whole gallery namespace (`galleries-secure/<galleryId>/` — all blobs + the index).
// Used by the editor's discard-cleanup for a gallery created in a draft that's abandoned without saving;
// the record-delete write-listener covers saved records. Behind admin write + CSRF.
export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop — never rely solely on the /api guard's path heuristic
  const body = await readBody(event)
  const ns = galleryNamespace(body?.galleryId)
  const driver = useStorageDriver()
  if (typeof driver.removeDir !== 'function') {
    // Don't report success for a delete that didn't happen — the whole namespace would orphan silently.
    console.warn(`[kestrel] galleries-secure: storage driver has no removeDir(); namespace "${ns}" was NOT deleted`)
    return { ok: false, removed: false }
  }
  await driver.removeDir(ns)
  return { ok: true, removed: true }
})
