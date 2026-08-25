import { and, eq, getTableColumns } from 'drizzle-orm'
import { getQuery, createError } from 'h3'
import { Effect } from 'effect'
import { definePipeline, eventOf, requireRegisteredCollection, useDb } from '@kestrel/core'
import type { StepDef } from '@kestrel/core'
import { useStorageDriver } from '@kestrel/media'

// Public endpoint so an anonymous customer can fetch ONE published gallery by exact slug. Scoped on purpose:
// returns only the ZK-safe field ref (salt + sealed verify-token + the unguessable namespace id) PLUS the
// public `base` URL where its encrypted index + ciphertext blobs live — for a PUBLISHED row only. No listing
// (galleries can't be enumerated), no other fields, no drafts. The client fetches `<base>/index.json` +
// `<base>/<blobId>` itself and decrypts with the password (zero-knowledge — the server reads neither).
const readPublicGallery: StepDef = {
  name: 'readPublicGallery',
  fn: (ctx) => Effect.sync(() => {
    const slug = getQuery(eventOf(ctx)).slug
    if (typeof slug !== 'string' || !slug) throw createError({ statusCode: 400, statusMessage: 'slug required' })

    const c = requireRegisteredCollection('galleries')

    const cols = getTableColumns(c.table) as Record<string, never>
    const row = useDb().select().from(c.table)
      .where(and(eq(cols.slug, slug), eq(cols.status, 'published')))
      .get() as { slug: string; gallery: unknown } | undefined
    if (!row) throw createError({ statusCode: 404, statusMessage: 'gallery not found' })

    const ref = row.gallery as { v?: number; galleryId?: string; saltB64?: string; verify?: unknown } | null
    if (!ref?.galleryId) throw createError({ statusCode: 404, statusMessage: 'gallery not found' })
    const base = useStorageDriver().publicUrl(`galleries-secure/${ref.galleryId}`)
    ctx.output = { slug: row.slug, gallery: { ...ref, base } } // ZK ref + storage base — never the whole record
  }),
}

export const publicGalleryPipeline = definePipeline({
  name: 'publicGallery',
  read: true,
  access: { public: true, scope: 'published' },
  steps: [readPublicGallery],
})
