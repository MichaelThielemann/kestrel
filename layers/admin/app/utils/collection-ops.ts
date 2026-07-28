// Wire shapes for the collection batch endpoint, shared by the ops composable and the delete dialog.
// Mirrors media/app/utils/ops.ts: one definition, no drift between the caller and the confirm UI.

/** The four batch actions the command endpoint accepts (a row action is a bulk op with one id). */
export type BatchAction = 'delete' | 'publish' | 'unpublish' | 'duplicate'

/** POST /api/{collection}/bulk response. For `duplicate`, `ids` are the CREATED rows. */
export interface BulkResult {
  action: BatchAction
  count: number
  ids: number[]
}

/** GET /api/references/referrers?ids=1,2,3 response: id -> how many other records reference it.
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
