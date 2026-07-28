import { and, eq, getTableColumns, inArray } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { recordRefs } from '../database/record-refs'
import { extractRecordRefs, extractLocatedRecordRefs, type FieldRef, type LocatedRef } from '../../../fields/server/utils/extract-refs'
import type { CollectionDef, FieldDef } from './defineCollection'
import { fieldIs } from './defineCollection'
import type { BuiltCollection } from './collection-types'
import { getCollection } from './registry'
import type { WriteEvent } from './write-events'

type DB = BetterSQLite3Database

/**
 * Maintain the `record_refs` edges for one content write (the write-events listener calls this).
 * Replace-on-write: a create / update / singleton PUT clears the source's existing edges and inserts the
 * freshly extracted set; a delete just clears them. Touches only the written source row's edges, so other
 * records' edges are untouched. Best-effort — the bus isolates a throwing listener, so a failure to keep
 * the index current never breaks the content write itself. The `before`/`after` rows are read, never mutated.
 */
export function maintainRecordRefs(db: DB, event: WriteEvent): void {
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

/** Why a reference is stale: its target row is gone, or present but not published. */
export type DeadReason = 'missing' | 'unpublished'

/** A reference plus its dead-ness reason, with field/block location for the editor's per-field warnings. */
export interface LocatedDeadRef extends LocatedRef {
  reason: DeadReason
}

/** Whether a collection has any field/block that can hold a reference — used to skip the derivation (and
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
    } catch {
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

/** Load a record by id and derive its stale references (for the editor's `/dead-refs` endpoint). */
export function recordDeadRefs(db: DB, c: BuiltCollection, id: number): LocatedDeadRef[] {
  const cols = getTableColumns(c.table) as Record<string, never>
  let row: Record<string, unknown> | undefined
  try {
    row = db.select().from(c.table as never).where(eq(cols.id, id)).get() as Record<string, unknown> | undefined
  } catch {
    return []
  }
  return row ? deriveLocatedDeadRefs(db, c.def, row) : []
}

/** The distinct records that reference a given target — the reverse "what links here" lookup (powers the
 *  pre-delete/unpublish warning). Read-only; tolerant of a not-yet-migrated index — returns `null` rather
 *  than `[]` on failure, so a caller can tell "checked, no referrers" from "could not check" and must not
 *  treat the latter as a green light to delete unwarned. */
export function findReferrers(db: DB, targetColl: string, targetId: number): FieldRef[] | null {
  try {
    return db.selectDistinct({ sourceColl: recordRefs.sourceColl, sourceId: recordRefs.sourceId })
      .from(recordRefs)
      .where(and(eq(recordRefs.targetColl, targetColl), eq(recordRefs.targetId, targetId)))
      .all()
      .map((r) => ({ collection: r.sourceColl, id: r.sourceId }))
  } catch {
    return null
  }
}

/**
 * Referrer COUNTS for a whole selection of targets in ONE query — the batched reverse lookup powering the
 * bulk-delete "what links here" warning. Returns `targetId -> number of distinct referrers`; a target with
 * no referrers is simply omitted. A referrer that is ITSELF in the selection is excluded, so deleting a
 * linked pair together raises no false warning. Read-only; tolerant of a not-yet-migrated index — returns
 * `null` (not `{}`) on failure, mirroring `findReferrers`'s indeterminate-vs-empty distinction.
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
  } catch {
    return null
  }
}

/** A referrer → dead-target edge, for the global broken-references report. */
export interface BrokenRef {
  source: FieldRef
  target: FieldRef
  reason: DeadReason
}

/** Every edge in the index whose target is currently dead — the global broken-references report. Scans the
 *  whole index (an admin maintenance view, not a hot path) and classifies all targets in one batch. Returns
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
  } catch {
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
