import { createError } from 'h3'
import { eq, inArray } from 'drizzle-orm'
import { Effect } from 'effect'
import { NotFound } from '@kestrel/contracts'
import type { KestrelError } from '@kestrel/contracts'
import { resolveLocale } from '../../utils/locale.js'
import { asValidated, assertNotSingleton, collectionOf, columns, dbOf, isSingletonWrite, singletonWhere, table, unitsOf, type Row } from './shared.js'
import { syncStep, type PipelineContext, type StepDef } from '../types.js'

/** Load the row a single-record update replaces. For a singleton PUT (no id) that is the row keyed by the
 *  collection name — plus the locale for a translatable singleton — so both shapes hand the same `before`
 * @public
 *  to every step downstream. Also the entry guard: the two 405s that separate the id routes from PUT. */
export function loadBeforeStep(): StepDef {
  return syncStep('loadBefore', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    const db = dbOf(ctx)
    const cols = columns(c)
    if (isSingletonWrite(ctx)) {
      if (c.def.mode !== 'single') throw createError({ statusCode: 405, statusMessage: 'PUT is only for singletons' })
      const loc = c.def.translatable ? resolveLocale(ctx.facts.locale) : undefined
      ctx.work.singletonLocale = loc
      const existing = db.select().from(table(c)).where(singletonWhere(cols, c, loc)).get() as Row | undefined
      unitsOf(ctx).push({ values: asValidated({}), before: existing ?? null })
      return
    }
    assertNotSingleton(c)
    const before = db.select().from(table(c)).where(eq(cols.id, ctx.id!)).get() as Row | undefined
    unitsOf(ctx).push({ values: asValidated({}), before: before ?? null })
  }))
}

/** Load every row a batch operation touches, in one query. `guard` runs first — the entry checks a batch
 *  op must fail on BEFORE it reports a missing id (a singleton, or a status patch on a collection that
 * @public
 *  has no status column). */
export function loadBeforeManyStep(
  ids: (ctx: PipelineContext) => Effect.Effect<number[], KestrelError>,
  guard?: (ctx: PipelineContext) => Effect.Effect<void, KestrelError>,
): StepDef {
  return syncStep('loadBefore', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    if (guard) yield* guard(ctx)
    const db = dbOf(ctx)
    const cols = columns(c)
    const wanted = yield* ids(ctx)
    ctx.work.ids = wanted
    const rows = db.select().from(table(c)).where(inArray(cols.id, wanted)).all() as Row[]
    const units = unitsOf(ctx)
    for (const before of rows) units.push({ values: asValidated({}), before })
  }))
}

/** ALL-OR-NOTHING: an id absent from THIS collection (a foreign or a stale one) aborts the whole batch with
 * @public
 *  a clean 404 before any write, so a partial silent success is impossible. */
export function assertAllExistStep(): StepDef {
  return syncStep('assertAllExist', (ctx) => {
    const c = collectionOf(ctx)
    const found = new Set(unitsOf(ctx).map((unit) => unit.before!.id as number))
    const missing = (ctx.work.ids as number[]).filter((id) => !found.has(id))
    // `ids` carries every missing id; `id` (required) stays the first, for a caller that only reads that.
    return missing.length ? Effect.fail(new NotFound({ collection: c.name, id: missing[0]!, ids: missing })) : Effect.void
  }, { sealed: true })
}
