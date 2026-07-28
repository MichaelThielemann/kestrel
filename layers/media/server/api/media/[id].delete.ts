import { eq, getTableColumns } from 'drizzle-orm'
import { media } from '../../collections/media'
import { useStorageDriver } from '../../../../core/server/utils/storage'
import { deleteAffected } from '../../utils/media-ops'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  requireMediaCollection()
  const id = requireId(event)
  const cols = getTableColumns(media) as Record<string, never>
  const db = useDb()
  // deleteAffected silently no-ops on a missing row, so keep an explicit 404 guard.
  const row = db.select({ id: cols.id }).from(media).where(eq(cols.id, id)).get() as { id: number } | undefined
  if (!row) throw createError({ statusCode: 404, statusMessage: `media ${id} not found` })
  await deleteAffected(db, useStorageDriver(), [{ type: 'file', id }], false)
  return { deleted: true, id }
})
