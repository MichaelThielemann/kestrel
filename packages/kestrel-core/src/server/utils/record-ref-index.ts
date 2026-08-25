import { and, eq, getTableColumns, inArray } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { recordRefs } from '../database/record-refs.js'
import { extractLocatedRecordRefs, extractRecordRefs, fieldIs } from '@kestrel/core'
import type { BuiltCollection, CollectionDef, FieldDef, FieldRef, LocatedRef } from '@kestrel/core'
import { allCollections, getCollection } from './registry.js'
import type { WriteEvent } from '../pipeline/steps/shared.js'
import type { ContentDb } from '../db/content-db.js'
import { OwnershipViolation } from '../db/module-db.js'
import type { ModuleDbBrand } from '../db/module-db.js'

// `Pick<ContentDb, K>` drops every key outside `K`, including `ModuleDbBrand` — each narrowed
// type below re-intersects it explicitly, so a raw `BetterSQLite3Database`/drizzle instance still fails to
// structurally satisfy it (a real, ownership-checked `ContentDb`, or `ModuleTxHandle`, does carry it).

/** The narrowest surface this module's read-side functions actually use: `select`/`selectDistinct`/
 *  `insert`/`delete`. */
type DB = Pick<ContentDb, 'select' | 'selectDistinct' | 'insert' | 'delete'> & { readonly [ModuleDbBrand]: true }

/** `maintainRecordRefs` only ever deletes/inserts — never selects — so it accepts the even narrower
 *  surface a `ModuleTxHandle` (the checked handle a `db.transaction(fn)` callback receives — see
 *  `module-db.ts`) also satisfies, letting `rebuildRecordRefs` call it from inside a transaction. */
type WriteDB = Pick<ContentDb, 'delete' | 'insert'> & { readonly [ModuleDbBrand]: true }

/** `rebuildRecordRefs` needs `select` (to read each collection's live rows) plus `transaction` (to run
 *  the purge+replay atomically) — nothing else. */
type RebuildDB = Pick<ContentDb, 'select' | 'transaction'> & { readonly [ModuleDbBrand]: true }

/**
 * Maintain the `record_refs` edges for one content write (the `reindexRefs` outbox handler —
 * `layers/core/server/handlers/reindex-refs.ts` — calls this). Replace-on-write: a create / update /
 * singleton PUT clears the source's existing edges and inserts the freshly extracted set; a delete just
 * clears them. Touches only the written source row's edges, so other records' edges are untouched. A
 * throw here is NOT isolated — it propagates to the outbox worker's retry/dead-letter machinery (see that
 * handler's TSDoc), unlike the old critical-path after-step this replaced. The `before`/`after` rows are
 * read, never mutated.
 * @public
 */
export function maintainRecordRefs(db: WriteDB, event: WriteEvent): void {
  const { def, before, after } = event
  const source = after ?? before
  const sourceId = source?.id
  if (typeof sourceId !== 'number') return

  // Clear the source's edges first — both the delete path and the create/update replace path need this.
  db.delete(recordRefs).where(and(eq(recordRefs.sourceColl, def.name), eq(recordRefs.sourceId, sourceId))).run()
  if (!after) return // delete: edges removed, nothing to re-insert.

  const refs = extractRecordRefs(def, after)
  if (!refs.length) return
  db.insert(recordRefs)
    .values(refs.map((r) => ({ sourceColl: def.name, sourceId, targetColl: r.collection, targetId: r.id })))
    .run()
}

/** Rebuild the whole `record_refs` index from scratch: purges the table, then for every registered
 *  collection replays every live row through the same `maintainRecordRefs` the write path uses. The
 *  purge is deliberate — this is the OFFICIAL recovery entry for a corrupted/lost index
 *  (the "derived" module class, `docs/internals/data-model.md`), so a stale/inconsistent edge left over from
 *  before the rebuild must not survive it. Runs purge+replay in ONE transaction: an untransacted version
 *  would leave the index fully purged with a partial replay if any row threw mid-loop (a malformed row,
 *  a constraint violation) — strictly worse than the stale state this function exists to repair. Either
 *  the new index lands complete or the old one survives untouched. No standalone CLI wraps it yet; call
 * @public
 *  this directly. */
export function rebuildRecordRefs(db: RebuildDB): void {
  db.transaction((tx) => {
    tx.delete(recordRefs).run()
    for (const c of allCollections()) {
      const rows = tx.select().from(c.table as never).all() as Record<string, unknown>[]
      for (const row of rows) maintainRecordRefs(tx, { def: c.def, before: null, after: row })
    }
  })
}

/** Why a reference is stale: its target row is gone, or present but not published.
 * @public
 */
export type DeadReason = 'missing' | 'unpublished'

/** A reference plus its dead-ness reason, with field/block location for the editor's per-field warnings.
 * @public
 */
export interface LocatedDeadRef extends LocatedRef {
  reason: DeadReason
}

/** Whether a collection has any field/block that can hold a reference — used to skip the derivation (and
 * @public
 *  to decide whether to offer the dead-reference column) for collections that can never have stale refs. */
export function collectionMayReference(def: CollectionDef): boolean {
  if (def.blocks?.enabled) return true
  if (def.seo) return true // the `seo` system column carries a media ref (the social image), tracked like any
  return Object.values(def.fields).some(fieldMayReference)
}
function fieldMayReference(field: FieldDef): boolean {
  // `fieldIs` not `switch`: the open consumer arm makes `type` a non-discriminant (no switch narrowing).
  if (fieldIs(field, 'repeater')) return Object.values(field.options.fields).some(fieldMayReference)
  return field.type === 'relation' || field.type === 'media' || field.type === 'link' || field.type === 'richtext'
}

/**
 * Classify a batch of reference targets as dead, in ONE query per target collection (no N+1). A target is
 * dead when its row is GONE, or — if its collection's table has a `status` column — present but not
 * `'published'` (so a consumer-added status on any collection is honoured automatically). An
 * unknown/unregistered target collection counts as missing. A not-yet-migrated target table (e.g. a bare
 * prerender DB) is treated as indeterminate (not dead), mirroring the link resolver's tolerance. Returns a
 * map keyed `"collection:id"` → reason, holding ONLY the dead targets.
 * @public
 */
export function deadTargets(db: DB, targets: FieldRef[]): Map<string, DeadReason> {
  const dead = new Map<string, DeadReason>()
  const byCollection = new Map<string, Set<number>>()
  for (const t of targets) {
    let ids = byCollection.get(t.collection)
    if (!ids) byCollection.set(t.collection, (ids = new Set()))
    ids.add(t.id)
  }
  for (const [collection, ids] of byCollection) {
    const c = getCollection(collection)
    if (!c) {
      for (const id of ids) dead.set(`${collection}:${id}`, 'missing')
      continue
    }
    const cols = getTableColumns(c.table) as Record<string, AnySQLiteColumn>
    const hasStatus = Object.hasOwn(cols, 'status')
    let rows: { id: number; status?: unknown }[]
    try {
      rows = db.select({ id: cols.id, ...(hasStatus ? { status: cols.status } : {}) })
        .from(c.table as never).where(inArray(cols.id, [...ids])).all() as { id: number; status?: unknown }[]
    } catch (e) {
      if (e instanceof OwnershipViolation) throw e // the guard must fail loud, never read as "not migrated"
      continue // table not migrated yet — don't false-flag.
    }
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) dead.set(`${collection}:${id}`, 'missing')
      else if (hasStatus && row.status !== 'published') dead.set(`${collection}:${id}`, 'unpublished')
    }
  }
  return dead
}

/** Every stale reference a record currently holds, with its field/block location and reason — derived
 * @public
 *  freshly from the record's value (so it auto-clears when the link is removed or the target restored). */
export function deriveLocatedDeadRefs(db: DB, def: CollectionDef, row: Record<string, unknown>): LocatedDeadRef[] {
  const located = extractLocatedRecordRefs(def, row)
  if (!located.length) return []
  const dead = deadTargets(db, located)
  if (!dead.size) return []
  const out: LocatedDeadRef[] = []
  for (const ref of located) {
    const reason = dead.get(`${ref.collection}:${ref.id}`)
    if (reason) out.push({ ...ref, reason })
  }
  return out
}

/** Load a record by id and derive its stale references (for the editor's `/dead-refs` endpoint).
 * @public
 */
export function recordDeadRefs(db: DB, c: BuiltCollection, id: number): LocatedDeadRef[] {
  const cols = getTableColumns(c.table) as Record<string, never>
  let row: Record<string, unknown> | undefined
  try {
    row = db.select().from(c.table as never).where(eq(cols.id, id)).get() as Record<string, unknown> | undefined
  } catch (e) {
    if (e instanceof OwnershipViolation) throw e // the guard must fail loud, never read as "not migrated"
    return []
  }
  return row ? deriveLocatedDeadRefs(db, c.def, row) : []
}

/** The distinct records that reference a given target — the reverse "what links here" lookup (powers the
 *  pre-delete/unpublish warning). Read-only; tolerant of a not-yet-migrated index — returns `null` rather
 *  than `[]` on failure, so a caller can tell "checked, no referrers" from "could not check" and must not
 * @public
 *  treat the latter as a green light to delete unwarned. */
export function findReferrers(db: DB, targetColl: string, targetId: number): FieldRef[] | null {
  try {
    return db.selectDistinct({ sourceColl: recordRefs.sourceColl, sourceId: recordRefs.sourceId })
      .from(recordRefs)
      .where(and(eq(recordRefs.targetColl, targetColl), eq(recordRefs.targetId, targetId)))
      .all()
      .map((r) => ({ collection: r.sourceColl, id: r.sourceId }))
  } catch (e) {
    if (e instanceof OwnershipViolation) throw e // the guard must fail loud, never read as "not migrated"
    return null
  }
}

/**
 * Referrer COUNTS for a whole selection of targets in ONE query — the batched reverse lookup powering the
 * bulk-delete "what links here" warning. Returns `targetId -> number of distinct referrers`; a target with
 * no referrers is simply omitted. A referrer that is ITSELF in the selection is excluded, so deleting a
 * linked pair together raises no false warning. Read-only; tolerant of a not-yet-migrated index — returns
 * `null` (not `{}`) on failure, mirroring `findReferrers`'s indeterminate-vs-empty distinction.
 * @public
 */
export function findReferrersForMany(db: DB, targetColl: string, ids: number[]): Record<number, number> | null {
  if (!ids.length) return {}
  try {
    const rows = db.selectDistinct({ sourceColl: recordRefs.sourceColl, sourceId: recordRefs.sourceId, targetId: recordRefs.targetId })
      .from(recordRefs)
      .where(and(eq(recordRefs.targetColl, targetColl), inArray(recordRefs.targetId, ids)))
      .all()
    const selected = new Set(ids)
    const counts: Record<number, number> = {}
    for (const r of rows) {
      if (r.sourceColl === targetColl && selected.has(r.sourceId)) continue // in-selection referrer → not counted
      counts[r.targetId] = (counts[r.targetId] ?? 0) + 1
    }
    return counts
  } catch (e) {
    if (e instanceof OwnershipViolation) throw e // the guard must fail loud, never read as "not migrated"
    return null
  }
}

/** A referrer → dead-target edge, for the global broken-references report.
 * @public
 */
export interface BrokenRef {
  source: FieldRef
  target: FieldRef
  reason: DeadReason
}

/** Every edge in the index whose target is currently dead — the global broken-references report. Scans the
 *  whole index (an admin maintenance view, not a hot path) and classifies all targets in one batch. Returns
 * @public
 *  `null` (not `[]`) when the index itself could not be read, mirroring `findReferrers`. */
export function findBrokenRefs(db: DB): BrokenRef[] | null {
  let edges: { sourceColl: string; sourceId: number; targetColl: string; targetId: number }[]
  try {
    edges = db.select({
      sourceColl: recordRefs.sourceColl,
      sourceId: recordRefs.sourceId,
      targetColl: recordRefs.targetColl,
      targetId: recordRefs.targetId,
    }).from(recordRefs).all()
  } catch (e) {
    if (e instanceof OwnershipViolation) throw e // the guard must fail loud, never read as "not migrated"
    return null
  }
  if (!edges.length) return []
  const dead = deadTargets(db, edges.map((e) => ({ collection: e.targetColl, id: e.targetId })))
  if (!dead.size) return []
  const out: BrokenRef[] = []
  for (const e of edges) {
    const reason = dead.get(`${e.targetColl}:${e.targetId}`)
    if (reason) out.push({ source: { collection: e.sourceColl, id: e.sourceId }, target: { collection: e.targetColl, id: e.targetId }, reason })
  }
  return out
}
