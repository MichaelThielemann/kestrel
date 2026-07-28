import { MAX_BULK_IDS } from '../../../app/utils/list-limits'
import { BULK_ACTIONS, isBulkAction, type BulkAction } from '../../../app/utils/bulk-actions'

// The ONE command endpoint for collection batch operations — the single wire surface behind both the
// per-row Quick Actions and the selection Bulk bar (a row action IS a bulk action with one id). POST is
// classified 'write' on the `{collection}` resource by the access guard (resourceForPath('/api/{c}/bulk')
// === '{c}'), so CSRF + per-collection policy apply exactly as for a single-record write — no bypass.
// A literal `bulk.post.ts` segment beats the dynamic `[id]` route (no `[id].post.ts` exists), so no clash.
//
//   body:  { action: 'delete' | 'publish' | 'unpublish' | 'duplicate', ids: number[] }
//   200:   { action, count, ids }        (for 'duplicate', `ids` are the CREATED ids)
//
// delete + publish/unpublish are all-or-nothing (an unknown id 404s before any write); duplicate is a
// sequential row action. All batching lives in crud.ts — this handler is a thin parse-and-dispatch.

function parseBulkBody(body: unknown): { action: BulkAction; ids: number[] } {
  const action = (body as { action?: unknown })?.action
  if (!isBulkAction(action)) {
    throw createError({ statusCode: 400, statusMessage: `Invalid bulk action: ${String(action)} (expected one of ${BULK_ACTIONS.join(', ')})` })
  }
  const ids = parseIdList((body as { ids?: unknown })?.ids, MAX_BULK_IDS)
  return { action, ids }
}

export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const collection = requireCollection(event)
  const { action, ids } = parseBulkBody(await readBody(event))
  const db = useDb()

  if (action === 'delete') return { action, ...removeMany(db, collection, ids) }
  if (action === 'duplicate') {
    const created = await duplicateMany(db, collection, ids)
    return { action, count: created.length, ids: created.map((r) => r.id as number) }
  }
  return { action, ...setStatusMany(db, collection, ids, action === 'publish' ? 'published' : 'draft') }
})
