import { eq, getTableColumns, inArray } from 'drizzle-orm'
import { createError } from 'h3'
import { Effect } from 'effect'
import { NotFound } from '@michaelthielemann/kestrel-contracts'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { MAX_BULK_IDS, OwnershipViolation, definePipeline, getCollection, getResolvedKestrelConfig, parseIdList, prefixPrimaryLocale, primaryLocale, syncStep, useDb } from '@michaelthielemann/kestrel-core'
import type { PipelineDef, StepDef } from '@michaelthielemann/kestrel-core'
import { publishStatus } from '../database/publish-status.js'
import { usePublishingDbFor } from '../db/publishing-db.js'
import { staleRoutes } from '../utils/publish/deps.js'
import { classifyWrite, planInvalidation } from '../utils/publish/invalidation.js'
import { hasPendingChanges } from '../utils/publish/pending.js'
import { usePublishRuntime } from '../utils/publish/publish-runtime.js'
import { allPublishedRoutes } from '../utils/publish/publisher.js'
import { routeForRecord } from '../utils/publish/route-for-record.js'

interface OutputConfig {
  driver?: 'local' | 's3'
  auto?: boolean
  publishOnSave?: boolean
}

/** Substitutes for Nitro's `import.meta.dev` (a build-time-replaced constant, unavailable to a package —
 *  same class of gap as `useRuntimeConfig()`, see `outputConfig()`'s own TSDoc below). Fail-safe-to-
 *  PRODUCTION, not fail-safe-to-dev: adopts `@michaelthielemann/kestrel-auth`'s `session.ts`'s own `explicitDev` polarity
 *  (`NODE_ENV === 'development' || 'test'`, or the `KESTREL_DEV=1` escape hatch) rather than
 *  `module-db.ts`'s `NODE_ENV !== 'production'` — that check gates MORE validation on an ambiguous
 *  environment (safe to over-check), where this one gates what the editor reports as "generating" (safe to
 *  UNDER-claim dev, never to wrongly claim production is idle). A deployment that simply omits `NODE_ENV`
 *  (a common slip when launching `.output/server/index.mjs`) must read as production here, not dev. */
function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' || process.env.KESTREL_DEV === '1'
}

/** Reads off the config-provider seam (`@michaelthielemann/kestrel-core`'s `getResolvedKestrelConfig`) — a package cannot
 *  reach the layer-only `serverRuntimeConfig()`/`useRuntimeConfig()` this used before the move. Same
 *  seam `publisher.ts`'s own `outputConfig()` uses; see its TSDoc for why this is behavior-identical. */
function outputConfig(): OutputConfig | undefined {
  return getResolvedKestrelConfig().output
}

/**
 * Publish records: write their static files (and everything whose baked output embeds them) to the
 * configured output — the deliberate second half of the split ADR-0008 introduced. Saving persists to the
 * DB and leaves the live site alone; THIS is what changes what visitors see.
 *
 *   body: `{ collection: string, ids?: number[], id?: number }`
 *   200:  `{ queued, generates, routes, pruned, drafts }`
 *
 * The record's publish INTENT (`status`) is not touched here — that is a field the editor saves like any
 * other, so a page goes live by being published while published. A draft is therefore reported back
 * (`drafts`) rather than silently promoted: it has no public output to write.
 *
 * All-or-nothing on lookup (an unknown id 404s before anything is enqueued), like the bulk write actions.
 */
const publishRecords: StepDef = syncStep('publishRecords', (ctx) => Effect.gen(function* () {
    const body = ctx.input
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
    if (missing.length) return yield* Effect.fail(new NotFound({ collection: c.def.name, id: missing[0]!, ids: missing }))

    // Where the next publish would go, and whether one happens here at all: in dev (or with `output.auto`
    // off) there is no runtime publisher, and saying so is more useful than a queued run that never runs.
    const output = outputConfig()
    const runtime = usePublishRuntime()
    const generates = !isDevMode() && !!output?.auto && !!runtime

    // The live route set answers "is this tracked route still somebody's page?" — the question a rename
    // leaves open. `failed` means the enumeration was incomplete, and an incomplete read must never drive a
    // delete, so the prune is skipped wholesale.
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

    ctx.output = { queued, generates, routes, pruned, drafts }
}))

/**
 * Admin-only read of the LIVE publish state of a record's static page (`?collection=&id=`). Resolves the
 * record's route, then looks up its `publish_status` row. Returns `{ route, status }` (+ error/updatedAt on
 * a row), or `{ route: null, status: null }` when the record has no route (non-pageLike / blank slug /
 * missing), or `{ route, status: null }` when there is no status row yet (never published — dev, a draft,
 * or a republish still in flight). The editor's live-ampel reads this and refetches after each save.
 */
const readPublishStatus: StepDef = syncStep('readPublishStatus', (ctx) => Effect.sync(() => {
    // Environment-level facts the right lamp needs beyond the per-route row: where the NEXT publish would go
    // (`driver`) and whether the runtime publisher actually produces files HERE (prod + `output.auto`). In dev
    // (or with auto off) nothing is ever generated, so the lamp shows a calm "Not built" instead of a stuck
    // "Generating".
    const output = outputConfig()
    // `publishOnSave` also tells the editor whether to offer a Publish button at all: with the split turned
    // off there is nothing left for it to do.
    const publishOnSave = !!output?.publishOnSave
    const env = { driver: (output?.driver ?? 'local') as 'local' | 's3', generates: !isDevMode() && !!output?.auto, publishOnSave }

    const q = (ctx.input ?? {}) as Record<string, unknown>
    const name = typeof q.collection === 'string' ? q.collection : ''
    const id = Number(typeof q.id === 'string' ? q.id : NaN)
    const c = getCollection(name)
    if (!c || !c.def.pageLike || !Number.isInteger(id) || id <= 0) {
      ctx.output = { route: null, status: null, pending: false, neverPublished: false, ...env }
      return
    }

    const db = useDb()
    const table = c.table as AnySQLiteTable
    const cols = getTableColumns(table) as Record<string, never>
    const row = db.select().from(table).where(eq(cols.id, id)).get() as { path?: unknown; locale?: unknown; updatedAt?: unknown } | undefined
    const route = routeForRecord(row, true, primaryLocale(), prefixPrimaryLocale())
    if (!route) {
      ctx.output = { route: null, status: null, pending: false, neverPublished: false, ...env }
      return
    }

    // Saved after it was last published: with publishing deferred to an explicit action, that is the normal
    // working state of a page being edited — the live file is the previous version until someone publishes.
    const savedAt = row?.updatedAt instanceof Date ? row.updatedAt.getTime() : null
    try {
      const pubDb = usePublishingDbFor(db).db
      const st = pubDb.select().from(publishStatus).where(eq(publishStatus.route, route)).get()
      // A routable page with no row was never published. Before the split that was indistinguishable from
      // "a publish is running" — a save always enqueued one — but now nothing is in flight and nothing will be
      // until someone presses Publish, so the lamp must not claim progress that is not happening.
      if (!st) {
        ctx.output = { route, status: null, pending: false, neverPublished: true, ...env }
        return
      }
      // With the split off, a save republishes on its own, so a newer save means a republish is in flight —
      // reporting that as "unpublished changes" would ask the user to act on something already happening.
      const pending = !publishOnSave && hasPendingChanges(savedAt, st.updatedAt instanceof Date ? st.updatedAt.getTime() : null)
      ctx.output = { route, status: st.status, error: st.error, updatedAt: st.updatedAt, target: st.target, pending, neverPublished: false, ...env }
    } catch (error) {
      if (error instanceof OwnershipViolation) throw error
      // publish_status not migrated yet → treat as "no status" rather than a 500. Not "never published"
      // either: the table is unreadable, so the page's real state is unknown, not known to be absent.
      ctx.output = { route, status: null, pending: false, neverPublished: false, ...env }
    }
}))

/** The `publish` write action and its `publishStatus` read companion.
 * @public
 */
export function buildPublishPipelines(): PipelineDef[] {
  return [
    definePipeline({ name: 'publish', access: { role: 'admin' }, steps: [publishRecords] }),
    definePipeline({ name: 'publishStatus', read: true, access: { role: 'admin' }, steps: [readPublishStatus] }),
  ]
}
