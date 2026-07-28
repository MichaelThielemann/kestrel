import { deleteAffected } from '../../utils/media-ops'
import { coerceOpItems } from '../../utils/relocate-ops'
import { useStorageDriver } from '../../../../core/server/utils/storage'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  requireMediaCollection()
  const body = await readBody(event)
  const items = coerceOpItems(body?.items)
  if (!items.length) throw createError({ statusCode: 400, statusMessage: 'No items to delete' })
  return deleteAffected(useDb(), useStorageDriver(), items, body?.dryRun === true)
})
