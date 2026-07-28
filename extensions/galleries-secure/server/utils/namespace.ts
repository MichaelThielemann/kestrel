// Validates the per-gallery storage namespace + blob filenames before any driver call — a path-traversal
// guard on top of the driver's own root guard. A gallery's ciphertext blobs + its encrypted index file all
// live under `galleries-secure/<galleryId>/`. `createError` is auto-imported (Nitro).
// Canonical UUID structure (8-4-4-4-12 hex) — what crypto.randomUUID() emits. Exported + shared so the
// field type and the cleanup planner validate a galleryId identically instead of keeping divergent copies.
const UUID_SHAPE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const GALLERY_ID_RE = new RegExp(`^${UUID_SHAPE}$`, 'i')
export const BLOB_ID_RE = new RegExp(`^${UUID_SHAPE}\\.bin$`, 'i')

/** `galleries-secure/<galleryId>` — throws 400 on a malformed id. */
export function galleryNamespace(galleryId: unknown): string {
  if (typeof galleryId !== 'string' || !GALLERY_ID_RE.test(galleryId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid galleryId' })
  }
  return `galleries-secure/${galleryId}`
}

/** A `<uuid>.bin` blob filename — throws 400 on anything else (no slashes, no traversal). */
export function blobName(blobId: unknown): string {
  if (typeof blobId !== 'string' || !BLOB_ID_RE.test(blobId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid blobId' })
  }
  return blobId
}
