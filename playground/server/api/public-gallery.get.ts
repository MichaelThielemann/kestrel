import { and, eq, getTableColumns } from 'drizzle-orm'

// Public endpoint so an anonymous customer can fetch ONE published gallery by exact slug. Scoped on purpose:
// returns only the ZK-safe field ref (salt + sealed verify-token + the unguessable namespace id) PLUS the
// public `base` URL where its encrypted index + ciphertext blobs live — for a PUBLISHED row only. No listing
// (galleries can't be enumerated), no other fields, no drafts. The client fetches `<base>/index.json` +
// `<base>/<blobId>` itself and decrypts with the password (zero-knowledge — the server reads neither).
// Anonymous access is granted narrowly via the core access grant seam (see ../plugins/public-gallery-grant).
// getCollection/useDb/getQuery/createError/useStorageDriver are auto-imported; drizzle helpers are imported.
export default defineEventHandler((event) => {
  const slug = getQuery(event).slug
  if (typeof slug !== 'string' || !slug) throw createError({ statusCode: 400, statusMessage: 'slug required' })

  const c = getCollection('galleries')
  if (!c) throw createError({ statusCode: 500, statusMessage: 'galleries collection not registered' })

  const cols = getTableColumns(c.table) as Record<string, never>
  const row = useDb().select().from(c.table)
    .where(and(eq(cols.slug, slug), eq(cols.status, 'published')))
    .get() as { slug: string; gallery: unknown } | undefined
  if (!row) throw createError({ statusCode: 404, statusMessage: 'gallery not found' })

  const ref = row.gallery as { v?: number; galleryId?: string; saltB64?: string; verify?: unknown } | null
  if (!ref?.galleryId) throw createError({ statusCode: 404, statusMessage: 'gallery not found' })
  const base = useStorageDriver().publicUrl(`galleries-secure/${ref.galleryId}`)
  return { slug: row.slug, gallery: { ...ref, base } } // ZK ref + storage base — never the whole record
})
