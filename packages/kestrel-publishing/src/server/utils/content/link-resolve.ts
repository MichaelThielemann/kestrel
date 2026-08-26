import { eq, getTableColumns } from 'drizzle-orm'
import { getCollection, pageRowHref, prefixPrimaryLocale, primaryLocale, useDb } from '@michaelthielemann/kestrel-core'
/** Whether a fetched target row may be linked from PUBLIC output: it must exist and — if its collection has a
 *  status column — be published. A draft target is NOT linkable, so its slug never leaks into published HTML
 *  (the caller maps the unresolved link to `'#'`). Pure (no DB) → unit-tested. */
/** @public */
export function isPubliclyLinkable(row: Record<string, unknown> | undefined, hasStatus: boolean): boolean {
  if (!row) return false
  return !hasStatus || row.status === 'published'
}

/**
 * Resolve an internal link `{collection, id}` to the target record's localized public path via the DB.
 * STATUS-GATED: a draft/unpublished target resolves to null → the link renders `'#'`, so its slug never
 * reaches published HTML (the editor is separately warned about draft/dead links via record-ref-index). The
 * baked href therefore encodes availability, which is why publishing/unpublishing a target emits the
 * `<coll>:<id>` tag and re-renders its referrers. Returns null for a non-page-like, missing, or draft target. Shared by the
 * populate plugin (read path, during `nuxt generate`) and the preview `/api/resolveLinks` endpoint, so both
 * resolve identically. Server-only (`useDb` by default; injectable for tests); tolerates an unmigrated DB → null.
 * @public
 */
export function resolveInternalHref(collection: string, id: number, db = useDb()): string | null {
  const c = getCollection(collection)
  if (!c?.def.pageLike) return null
  const cols = getTableColumns(c.table) as Record<string, never>
  let row: Record<string, unknown> | undefined
  try {
    row = db.select().from(c.table).where(eq(cols.id, id)).get() as Record<string, unknown> | undefined
  } catch (error) {
    // Still null (a throw would 500 every page holding an internal link on a bare prerender DB), but the
    // memo caches that null run-wide as "not linkable", so the dead link needs a trace to be diagnosable.
    console.error(`[kestrel] resolveInternalHref: ${collection}:${id} unreadable:`, (error as Error)?.message ?? error)
    return null
  }
  if (!isPubliclyLinkable(row, Object.hasOwn(cols, 'status'))) return null
  return pageRowHref(row, primaryLocale(), prefixPrimaryLocale())
}
