// Store one CIPHERTEXT image blob in a gallery's namespace. The editor encrypted it client-side, so the
// server NEVER sees the plaintext, the password, or the key — it just persists opaque bytes via Kestrel's
// storage driver under `galleries-secure/<galleryId>/<uuid>.bin` and returns the blob filename + its public
// URL. Under `/api/` → behind Kestrel's auth guard (admin write) + CSRF; anonymous is denied. The blob is
// served STATICALLY as opaque ciphertext; the viewer decrypts it client-side. `useStorageDriver` /
// `defineEventHandler` / `readRawBody` / `getQuery` / `createError` + `galleryNamespace` are auto-imported.
export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop — never rely solely on the /api guard's path heuristic
  const ns = galleryNamespace(getQuery(event).galleryId)
  // Bound the ciphertext size (parity with the media upload): a missing/garbage Content-Length means a
  // chunked transfer readRawBody would buffer with no ceiling — refuse it; a declared over-cap length is a
  // cheap 413 before reading; the real cap is re-asserted on the buffered bytes (a client can under-declare).
  const max = mediaRuntimeConfig().maxUploadBytes
  const len = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isFinite(len) || len < 0) throw createError({ statusCode: 411, statusMessage: 'Length required' })
  if (len > max) throw createError({ statusCode: 413, statusMessage: 'Payload too large' })
  const body = await readRawBody(event, false)
  const bytes = body instanceof Buffer ? new Uint8Array(body) : null
  if (!bytes?.length) throw createError({ statusCode: 400, statusMessage: 'empty ciphertext body' })
  if (bytes.length > max) throw createError({ statusCode: 413, statusMessage: 'Payload too large' })

  const driver = useStorageDriver()
  const blobId = `${crypto.randomUUID()}.bin`
  const key = `${ns}/${blobId}`
  await driver.put(key, bytes, 'application/octet-stream')
  return { blobId, url: driver.publicUrl(key) }
})
