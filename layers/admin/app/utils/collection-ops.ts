// Wire shapes for the collection batch endpoint, shared by the ops composable and the delete dialog.
// Mirrors media/app/utils/ops.ts: one definition, no drift between the caller and the confirm UI.
import type { SerializedAction } from '@michaelthielemann/kestrel-core'

/** The four batch actions the command endpoint accepts (a row action is a bulk op with one id). */
export type BatchAction = 'delete' | 'publish' | 'unpublish' | 'duplicate'

/** The built-in actions the admin renders with its own dedicated presentation (Delete/Duplicate buttons,
 *  the Publish/Unpublish pair) — always present on the wire, but never re-rendered generically. */
const BUILTIN_ACTION_NAMES = new Set(['deleteMany', 'duplicate'])

/** The schema-driven actions beyond the built-ins — what a consumer's `definePipeline` adds. */
export function customActions(actions: SerializedAction[]): SerializedAction[] {
  return actions.filter((a) => !BUILTIN_ACTION_NAMES.has(a.name))
}

/** Custom actions invokable from the bulk-selection bar. */
export function bulkCustomActions(actions: SerializedAction[]): SerializedAction[] {
  return customActions(actions).filter((a) => a.kind === 'bulk' || a.kind === 'both')
}

/** Custom actions invokable from a single row. */
export function recordCustomActions(actions: SerializedAction[]): SerializedAction[] {
  return customActions(actions).filter((a) => a.kind === 'record' || a.kind === 'both')
}

/** What a batch pipeline answers with: `deleteMany`/`updateMany` a count plus the ids they touched,
 *  `duplicate` the created rows. */
export type BatchPipelineResult = { count: number, ids: number[] } | { id: number }[]

/** The batch outcome the list UI reports. For `duplicate`, `ids` are the CREATED rows. A custom action's
 *  `action` is its pipeline name — not one of the four built-ins. */
export interface BulkResult {
  action: BatchAction | (string & {})
  count: number
  ids: number[]
}

/** GET /api/{collection}/referrers?ids=1,2,3 response: id -> how many other records reference it.
 *  `checked` is false when the index lookup itself failed, in which case `counts` is empty because nothing
 *  could be read — NOT because nothing links to the selection. */
export interface ReferrerCounts {
  counts: Record<string, number>
  checked: boolean
}

/** The pre-delete summary shown in the confirm dialog: how many rows, and how many of them other
 *  records still link to (aggregated from the referrer counts). */
export interface BatchDeleteReport {
  /** How many rows are about to be deleted. */
  count: number
  /** How many of those rows are referenced by at least one other record. */
  referencedCount: number
  /** Per-id breakdown for the referenced rows (id + inbound referrer count), in input order. */
  referenced: { id: number; referrers: number }[]
  /** Whether the referrer lookup actually ran. `false` means the check FAILED (not "none found"), so
   *  the dialog must warn that inbound links are unverified rather than imply a safe delete. */
  checked: boolean
}

/** Fold the referrer-count map into a delete report — pure, so it is unit-testable without a network.
 *  `checked` is the lookup's own outcome and is carried through untouched: an empty `counts` is ambiguous
 *  on its own, and only this flag tells the dialog whether it may claim nothing links to the selection. */
export function buildDeleteReport(ids: number[], counts: Record<string, number>, checked: boolean): BatchDeleteReport {
  const referenced = ids
    .map((id) => ({ id, referrers: Number(counts[String(id)] ?? 0) }))
    .filter((r) => r.referrers > 0)
  return { count: ids.length, referencedCount: referenced.length, referenced, checked }
}
