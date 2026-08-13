import { inArray, getTableColumns } from 'drizzle-orm'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { MAX_BULK_IDS } from '../../../core/app/utils/list-limits'
import { classifyWrite, planInvalidation } from '../utils/publish/invalidation'
import { staleRoutes } from '../utils/publish/deps'
import { usePublishRuntime } from '../utils/publish/publish-runtime'
import { allPublishedRoutes } from '../utils/publish/publisher'

/**
 * Publish records: write their static files (and everything whose baked output embeds them) to the
 * configured output — the deliberate second half of the split ADR-0008 introduced. Saving persists to the
 * DB and leaves the live site alone; THIS is what changes what visitors see.
 *
 *   body: { collection: string, ids?: number[], id?: number }
 *   200:  { queued, generates, routes, pruned, drafts }
 *
 * The record's publish INTENT (`status`) is not touched here — that is a field the editor saves like any
 * other, so a page goes live by being published while published. A draft is therefore reported back
 * (`drafts`) rather than silently promoted: it has no public output to write.
 *
 * All-or-nothing on lookup (an unknown id 404s before anything is enqueued), like the bulk write actions.
 */
export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const body = await readBody(event)
  const name = typeof (body as { collection?: unknown })?.collection === 'string' ? (body as { collection: string }).collection : ''
  const c = getCollection(name)
  if (!c) throw createError({ statusCode: 404, statusMessage: `Unknown collection: ${name}` })

  const raw = (body as { ids?: unknown; id?: unknown })?.ids ?? [(body as { id?: unknown })?.id]
  const ids = parseIdList(raw, MAX_BULK_IDS)

  const db = useDb()
  const table = c.table as AnySQLiteTable
  const cols = getTableColumns(table) as Record<string, never>
  const rows = db.select().from(table).where(inArray(cols.id, ids)).all() as Record<string, unknown>[]
  const found = new Set(rows.map((r) => r.id as number))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) throw createError({ statusCode: 404, statusMessage: `${c.def.name} not found: ${missing.join(', ')}` })

  // Where the next publish would go, and whether one happens here at all: in dev (or with `output.auto`
  // off) there is no runtime publisher, and saying so is more useful than a queued run that never runs.
  const output = (useRuntimeConfig().kestrel as { output?: { auto?: boolean } }).output
  const runtime = usePublishRuntime()
  const generates = !import.meta.dev && !!output?.auto && !!runtime

  // The live route set answers "is this tracked route still somebody's page?" — the question a rename
  // leaves open. `failed` means the enumeration was incomplete, and an incomplete read must never drive a
  // delete (the standing rule from the 2026-07-25 audit), so the prune is skipped wholesale.
  const liveNow = runtime ? allPublishedRoutes() : { routes: [], failed: ['*'] }
  const prunable = liveNow.failed.length === 0

  const primary = primaryLocale()
  const prefixPrimary = prefixPrimaryLocale()
  const routes: string[] = []
  const pruned: string[] = []
  const drafts: number[] = []
  let queued = false

  for (const row of rows) {
    // before === after: nothing about the record is changing, this is a re-render of its current state.
    // A draft classifies as not-published, so `planInvalidation` returns a noop for it — reported below.
    const ev = classifyWrite(c.def, row, row, primary, prefixPrimary)
    const inv = planInvalidation(ev)
    if (inv.type !== 'tags') {
      drafts.push(row.id as number)
      continue
    }
    // Abandoned URLs: routes the publisher baked FROM this record (tagged with its id) that no live page
    // claims any more — in practice the old file a published rename left behind. Same rule a full publish
    // applies globally, scoped to this record's tag; a referrer or listing carrying the tag is a live route
    // and therefore never in this set.
    const tagged = ev.id != null ? (runtime?.deps.routesForTags([`${c.def.name}:${ev.id}`]) ?? []) : []
    const stale = prunable ? staleRoutes(tagged, liveNow.routes) : []
    routes.push(...inv.render)
    pruned.push(...stale)
    if (runtime) {
      runtime.queue.enqueue({ ...inv, prune: [...inv.prune, ...stale] })
      queued = true
    }
  }

  return { queued, generates, routes, pruned, drafts }
})
