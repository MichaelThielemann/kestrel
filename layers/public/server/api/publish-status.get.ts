import { eq, getTableColumns } from 'drizzle-orm'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { publishStatus } from '../database/publish-status'
import { routeForRecord } from '../utils/publish/route-for-record'

/**
 * Admin-only read of the LIVE publish state of a record's static page (`?collection=&id=`). Admin-only by
 * construction: `/api/*` is default-deny for anonymous and `publish-status` is not a public pageLike
 * resource, so the access guard rejects an unauthenticated request before this runs. Resolves the record's
 * route, then looks up its `publish_status` row. Returns `{ route, status }` (+ error/updatedAt on a row),
 * or `{ route: null, status: null }` when the record has no route (non-pageLike / blank slug / missing),
 * or `{ route, status: null }` when there is no status row yet (never published — dev, a draft, or a
 * republish still in flight). The editor's live-ampel reads this and refetches after each save.
 */
export default defineEventHandler((event) => {
  // Environment-level facts the right lamp needs beyond the per-route row: where the NEXT publish would go
  // (`driver`) and whether the runtime publisher actually produces files HERE (prod + `output.auto`). In dev
  // (or with auto off) nothing is ever generated, so the lamp shows a calm "Not built" instead of a stuck
  // "Generating". Read straight from runtimeConfig — no need to pull in the whole publisher module.
  const output = (useRuntimeConfig().kestrel as { output?: { driver?: 'local' | 's3'; auto?: boolean } }).output
  const env = { driver: (output?.driver ?? 'local') as 'local' | 's3', generates: !import.meta.dev && !!output?.auto }

  const q = getQuery(event)
  const name = typeof q.collection === 'string' ? q.collection : ''
  const id = Number(typeof q.id === 'string' ? q.id : NaN)
  const c = getCollection(name)
  if (!c || !c.def.pageLike || !Number.isInteger(id) || id <= 0) return { route: null, status: null, ...env }

  const db = useDb()
  const table = c.table as AnySQLiteTable
  const cols = getTableColumns(table) as Record<string, never>
  const row = db.select().from(table).where(eq(cols.id, id)).get() as { path?: unknown; locale?: unknown } | undefined
  const route = routeForRecord(row, true, primaryLocale(), prefixPrimaryLocale())
  if (!route) return { route: null, status: null, ...env }

  try {
    const st = db.select().from(publishStatus).where(eq(publishStatus.route, route)).get()
    if (!st) return { route, status: null, ...env }
    return { route, status: st.status, error: st.error, updatedAt: st.updatedAt, target: st.target, ...env }
  } catch {
    // publish_status not migrated yet → treat as "no status" rather than a 500.
    return { route, status: null, ...env }
  }
})
