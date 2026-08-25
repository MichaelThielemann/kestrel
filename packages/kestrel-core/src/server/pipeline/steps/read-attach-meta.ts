import { and, eq, inArray } from 'drizzle-orm'
import { Effect } from 'effect'
import { recordRefs } from '../../database/record-refs.js'
import { collectionMayReference, deadTargets } from '../../utils/record-ref-index.js'
import { supportedLocales } from '../../utils/locale.js'
import { useContentDbFor, type ContentDb } from '../../db/content-db.js'
import { OwnershipViolation } from '../../db/module-db.js'
import { collectionOf, columns, dbOf, table, type Row } from './shared.js'
import { publishedOnlyOf, type ListResult } from './read-shared.js'
import type { BuiltCollection } from '@kestrel/core'
import { syncStep, type StepDef } from '../types.js'

type DB = ContentDb

/**
 * Attach `$hasDeadRefs` (a boolean sidecar, like `$translations`) to a page of admin list rows in ONE
 * batched query over `record_refs` (no N+1): true when any reference the row holds points at a deleted or
 * unpublished target. A no-op for collections that can never hold a reference. The warning is DERIVED on
 * read, so it clears the instant the link is removed/repointed or the target is restored/republished.
 */
function attachDeadRefs(db: DB, c: BuiltCollection, rows: Row[]): void {
  if (rows.length === 0 || !collectionMayReference(c.def)) return
  const ids = rows.map((r) => r.id).filter((x): x is number => typeof x === 'number')
  if (!ids.length) return
  let edges: { sourceId: number; targetColl: string; targetId: number }[]
  try {
    edges = db.select({ sourceId: recordRefs.sourceId, targetColl: recordRefs.targetColl, targetId: recordRefs.targetId })
      .from(recordRefs).where(and(eq(recordRefs.sourceColl, c.def.name), inArray(recordRefs.sourceId, ids))).all()
  } catch (e) {
    if (e instanceof OwnershipViolation) throw e // the guard must fail loud, never read as "not migrated"
    return // record_refs not migrated yet (e.g. a bare DB) — derive no warnings rather than break the list.
  }
  for (const r of rows) r.$hasDeadRefs = false
  if (!edges.length) return
  const dead = deadTargets(db, edges.map((e) => ({ collection: e.targetColl, id: e.targetId })))
  if (!dead.size) return
  const deadSources = new Set<number>()
  for (const e of edges) if (dead.has(`${e.targetColl}:${e.targetId}`)) deadSources.add(e.sourceId)
  for (const row of rows) if (deadSources.has(row.id as number)) row.$hasDeadRefs = true
}

/**
 * Attach the per-row translation status (`$translations`: locale → sibling row id, or null when the
 * locale is missing) for a page of list rows in a SINGLE batched query — the no-N+1 alternative to
 * calling resolveTranslations() once per row. Same shape as resolveTranslations(); the `$`-prefix
 * marks it a server-computed sidecar (mirrors the media `$media` convention), so it never collides
 * with a user-defined field. Only multi-mode translatable collections own a translationGroup, so it
 * is a no-op (and issues no query) for every other collection and for an empty page. The sibling
 * lookup honours `publishedOnly` (same as the page query) so a published-scope read never reveals
 * draft translations.
 */
function attachTranslationStatus(db: DB, c: BuiltCollection, rows: Row[], publishedOnly: boolean): void {
  if (c.def.mode !== 'multi' || !c.def.translatable || rows.length === 0) return
  const cols = columns(c)
  const groups = [...new Set(rows.map((r) => r.translationGroup as string).filter((g) => g != null))]
  if (groups.length === 0) return

  const conds = [inArray(cols.translationGroup, groups)]
  if (publishedOnly && Object.hasOwn(cols, 'status')) conds.push(eq(cols.status, 'published'))
  const siblings = db.select({ translationGroup: cols.translationGroup, locale: cols.locale, id: cols.id })
    .from(table(c)).where(and(...conds)).all() as Array<{ translationGroup: string; locale: string; id: number }>

  const byGroup = new Map<string, Record<string, number | null>>()
  for (const g of groups) {
    const map: Record<string, number | null> = {}
    for (const loc of supportedLocales()) map[loc] = null
    byGroup.set(g, map)
  }
  for (const s of siblings) byGroup.get(s.translationGroup)![s.locale] = s.id
  for (const r of rows) {
    const g = r.translationGroup as string | undefined
    if (g != null) r.$translations = byGroup.get(g) ?? null
  }
}

/** `readMany` only — `readOne`/getSingleton have no batch of sibling rows to attach a sidecar over.
 * @public
 */
export function attachMetaStep(): StepDef {
  return syncStep('attachMeta', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    // `c` may be a caller-built collection never passed through `registerCollection` (crud.ts takes an
    // explicit `BuiltCollection`, independent of the registry) — union it in so its own table still
    // counts as owned.
    const db = useContentDbFor(dbOf(ctx), c).db
    // The same scope resolution as the fetch steps — `ctx.work.publishedOnly` is stripped for an HTTP
    // run (the gate's readScope is the answer there), so reading it directly would always see false.
    const publishedOnly = publishedOnlyOf(ctx)
    const { data } = ctx.output as ListResult
    attachTranslationStatus(db, c, data, publishedOnly)
    // Dead-reference warnings are an admin-editor signal; skip the extra query on published-scope
    // (public / prerender) reads, where it is irrelevant and would tax the hot path.
    if (!publishedOnly) attachDeadRefs(db, c, data)
  }))
}
