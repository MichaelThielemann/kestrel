import { eq, getTableColumns } from 'drizzle-orm'
import { createError } from 'h3'
import { Effect } from 'effect'
import { ValidationFailed } from '@kestrel/contracts'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { MAX_BULK_IDS } from '../../../app/utils/list-limits.js'
import { resolveTranslations } from '../../utils/translations.js'
import { parseIdList } from '../../utils/http.js'
import { pickerOptions } from '../../utils/picker.js'
import { recordDeadRefs } from '../../utils/record-ref-index.js'
import { useContentDbFor } from '../../db/content-db.js'
import { collectionOf, dbOf, requireRecordId } from './shared.js'
import { publishedOnlyOf } from './read-shared.js'
import { syncStep, type StepDef } from '../types.js'

type Query = Record<string, unknown>

/** @public */
export function pickerOptionsStep(): StepDef {
  return syncStep('pickerOptions', (ctx) => Effect.sync(() => {
    const query = (ctx.input ?? {}) as Query
    ctx.output = pickerOptions(dbOf(ctx), collectionOf(ctx), {
      search: query.search ? String(query.search) : undefined,
      ids: query.ids ? parseIdList(query.ids, MAX_BULK_IDS) : undefined,
      label: query.label ? String(query.label) : undefined,
      page: query.page ? Number(query.page) : undefined,
      perPage: query.perPage ? Number(query.perPage) : undefined,
      locale: query.locale ? String(query.locale) : undefined,
      // Match the generic reads: a published-scope read (anonymous / SSG) must not surface draft labels.
      publishedOnly: publishedOnlyOf(ctx),
    })
  }))
}

/** The sibling map, keyed either by record id (`/translations/:id`) or — for a record that does not exist
 *  yet, which knows its group but has no id — by translation group (`?group=`). The group form resolves one
 * @public
 *  member and hands off to the same map builder, so the two entry points can never answer differently. */
export function resolveTranslationsStep(): StepDef {
  return syncStep('resolveTranslations', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    const db = dbOf(ctx)
    if (ctx.id !== undefined) {
      ctx.output = resolveTranslations(db, c, ctx.id)
      return
    }
    // Checked before the member lookup: a collection without translations has no translationGroup
    // column, so the query below would blow up on an undefined column.
    if (c.def.mode === 'single' || !c.def.translatable) {
      return yield* Effect.fail(new ValidationFailed({ issues: [{ path: [], message: 'Translations are not enabled for this collection' }] }))
    }
    const group = String((ctx.input as Query)?.group ?? '').trim()
    if (!group) return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['group'], message: 'A translation group is required' }] }))
    const cols = getTableColumns(c.table) as Record<string, AnySQLiteColumn>
    const member = db.select({ id: cols.id }).from(c.table).where(eq(cols.translationGroup, group)).get() as { id: number } | undefined
    if (!member) throw createError({ statusCode: 404, statusMessage: `Unknown translation group: ${group}` })
    ctx.output = resolveTranslations(db, c, member.id)
  }))
}

/** Every reference this record holds that now points at a deleted or unpublished target, with its
 * @public
 *  field/block location + reason. Derived on read, so it auto-clears when the link is fixed. */
export function recordDeadRefsStep(): StepDef {
  return syncStep('recordDeadRefs', (ctx) => Effect.gen(function* () {
    const id = yield* requireRecordId(ctx)
    const c = collectionOf(ctx)
    // See read-attach-meta.ts's attachMetaStep for why `c` must be unioned in.
    ctx.output = recordDeadRefs(useContentDbFor(dbOf(ctx), c).db, c, id)
  }))
}
