// Return the public `base` URL of a gallery's namespace so the editor knows where to fetch the encrypted
// index (`<base>/index.json`) + decrypt blobs (`<base>/<blobId>`). The id is in the field value, but the
// public URL depends on the driver (local `/uploads` vs S3 CDN), so the server resolves it. Behind admin.
export default defineEventHandler((event) => {
  const ns = galleryNamespace(getQuery(event).galleryId)
  return { base: useStorageDriver().publicUrl(ns) }
})
