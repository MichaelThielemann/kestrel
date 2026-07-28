import { eq, getTableColumns } from 'drizzle-orm'
import { media } from '../../collections/media'
import { mergeTranslations, type Translations } from '../../utils/translations'
import { emitMediaWrite } from '../../utils/media-write'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  requireMediaCollection()
  const id = requireId(event)
  const body = await readBody(event)
  const cols = getTableColumns(media) as Record<string, never>
  const db = useDb()
  const expectedUpdatedAt = readIfUnmodifiedSince(event)
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  // `folder` is immutable via PATCH: relocating a file means moving its storage object and every
  // derivative, which belongs to the media-library slice. Writing only the column would desync it
  // from the folder baked into storageKey, which is what the public URL is built from.
  const needsCurrent = expectedUpdatedAt !== undefined
    || (body?.translations && typeof body.translations === 'object' && !Array.isArray(body.translations))
  const current = needsCurrent
    ? db.select().from(media).where(eq(cols.id, id)).get() as { translations?: Translations; updatedAt?: Date } | undefined
    : undefined
  // Optimistic concurrency: honor the same X-Kestrel-If-Unmodified-Since precondition the collection CRUD
  // does, so two media-viewer tabs editing the same asset's alt text can't silently overwrite each other.
  if (expectedUpdatedAt !== undefined && current) {
    const cur = current.updatedAt instanceof Date ? current.updatedAt.getTime() : new Date(current.updatedAt as never).getTime()
    if (cur !== expectedUpdatedAt) {
      throw createError({ statusCode: 409, statusMessage: 'This media item changed since you opened it. Reload before saving.' })
    }
  }
  if (body?.translations && typeof body.translations === 'object' && !Array.isArray(body.translations)) {
    // Media keeps all locales in one JSON column. Deep-merge per locale so a partial PATCH (e.g. just
    // `en.alt` from the media viewer) keeps the other locales AND the locale's other fields intact.
    patch.translations = mergeTranslations(current?.translations, body.translations as Translations)
  }
  const row = db.update(media).set(patch).where(eq(cols.id, id)).returning().get() as Record<string, unknown> | undefined
  if (!row) throw createError({ statusCode: 404, statusMessage: `media ${id} not found` })
  emitMediaWrite({ id }, row) // alt/title/description changed → re-render embedding pages (fresh alt text)
  return row
})
