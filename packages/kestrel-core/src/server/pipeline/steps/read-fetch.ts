import { and, count, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { NotFound } from '@michaelthielemann/kestrel-contracts'
import { primaryLocale, resolveLocale } from '../../utils/locale.js'
import { captureRead } from '@michaelthielemann/kestrel-core'
import { collectionOf, columns, dbOf, singletonWhere, table, type Row } from './shared.js'
import type { ParsedListQuery } from './read-parse-query.js'
import { publishedOnlyOf, type ListQuery, type ListResult } from './read-shared.js'
import { syncStep, type StepDef } from '../types.js'

/** Read-scope enforcement (`publishedOnly`) lives here, not in `parseQuery` — SEALED because it is the one
 * @public
 *  place a published-scope read is kept from ever seeing a draft row. */
export function fetchManyStep(): StepDef {
  return syncStep('fetch', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    const db = dbOf(ctx)
    const parsed = ctx.work.parsedQuery as ParsedListQuery
    const q = ctx.input as ListQuery
    const publishedOnly = publishedOnlyOf(ctx)
    const conds = publishedOnly && Object.hasOwn(parsed.cols, 'status')
      ? [...parsed.conds, eq(parsed.cols.status, 'published')]
      : parsed.conds
    const where = conds.length ? and(...conds) : undefined

    const rawData = db.select().from(table(c)).where(where)
      .orderBy(parsed.direction(parsed.orderColumn)).limit(parsed.perPage).offset((parsed.page - 1) * parsed.perPage).all() as Row[]
    const totalRow = q.withTotal === false
      ? undefined
      : db.select({ value: count() }).from(table(c)).where(where).get() as { value: number } | undefined

    ctx.output = { data: rawData, total: Number(totalRow?.value ?? 0), page: parsed.page, perPage: parsed.perPage } satisfies ListResult
  }), { sealed: true })
}

/** `fetch` for `readOne` — also absorbs the singleton lookup (`ctx.id === undefined`, mirroring how
 *  `updateOne`'s `loadBefore` absorbed the singleton PUT). A singleton miss/unpublished row is not-found
 *  (`getSingleton` returns null); a by-id miss/unpublished row 404s (`getOne` throws) — same divergence the
 * @public
 *  two crud.ts facades had before decomposition. */
export function fetchOneStep(): StepDef {
  return syncStep('fetch', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    const db = dbOf(ctx)
    const cols = columns(c)
    const publishedOnly = publishedOnlyOf(ctx)

    if (ctx.id === undefined) {
      captureRead(c.def.name) // a singleton (nav/settings/footer) is global — any page that reads it depends on it
      const loc = c.def.translatable ? resolveLocale(ctx.facts.locale) : primaryLocale()
      const row = db.select().from(table(c)).where(singletonWhere(cols, c, c.def.translatable ? loc : undefined)).get() as Row | undefined
      if (!row || (publishedOnly && Object.hasOwn(cols, 'status') && row.status !== 'published')) {
        ctx.work.notFound = true
        return
      }
      ctx.work.row = row
      ctx.work.locale = loc
      return
    }

    captureRead(c.def.name, ctx.id) // a detail read depends on exactly this record
    const row = db.select().from(table(c)).where(eq(cols.id, ctx.id)).get() as Row | undefined
    if (!row) return yield* Effect.fail(new NotFound({ collection: c.name, id: ctx.id }))
    if (publishedOnly && Object.hasOwn(cols, 'status') && row.status !== 'published') {
      return yield* Effect.fail(new NotFound({ collection: c.name, id: ctx.id }))
    }
    ctx.work.row = row
    ctx.work.locale = c.def.translatable ? resolveLocale(ctx.facts.locale) : primaryLocale()
  }), { sealed: true })
}
