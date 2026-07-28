import { ensureFolder } from '../../utils/folders'
import { sanitizeFolder } from '../../utils/naming'
import { useStorageDriver } from '../../../../core/server/utils/storage'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  requireMediaCollection()
  const body = await readBody(event)
  const path = sanitizeFolder(typeof body?.path === 'string' ? body.path : '')
  if (!path) throw createError({ statusCode: 400, statusMessage: 'A non-empty folder path is required' })
  // ensureDir (mkdir, can throw ENAMETOOLONG/ENOTDIR/etc.) runs BEFORE the row commit — a folder row
  // with no backing directory would list forever with every upload/retry into it failing the same way.
  await useStorageDriver().ensureDir?.(path)
  const db = useDb()
  ensureFolder(db, path)
  return { path }
})
