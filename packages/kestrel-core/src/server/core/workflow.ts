/** @public */
export type Status = 'draft' | 'published'
/** @public */
export type GuardName = 'conditionsValid'

/** @public */
export interface TransitionRow {
  from: Status
  to: Status
  guard?: GuardName
}

/**
 * Every legal status move, one row per (from, to) pair over today's closed `Status` union. A guard names
 * a precondition the CALLER has already evaluated into `guardResults` — `canTransition` never runs a
 * guard itself, only checks the caller's verdict for it.
 *
 * Self-pairs (`draft->draft`, `published->published`) are explicit no-op rows rather than a
 * `from === to` special case in `canTransition`: a bulk publish/unpublish over a mixed list of ids hits
 * rows already at the target status, and that must stay a legal no-op, not a rejected transition. Each
 * self-pair carries the SAME guard as the real transition to that target (`published->published` is
 * gated by `conditionsValid` exactly like `draft->published`; `draft->draft` is ungated exactly like
 * `published->draft`) — the guard belongs to the target status, not the specific (from, to) pair, so
 * re-publishing an already-published row is re-validated the same as any other publish, and re-taking an
 * already-draft row offline is never blockable, same as any unpublish.
 * @public
 */
export const transitions: ReadonlyArray<TransitionRow> = [
  { from: 'draft', to: 'published', guard: 'conditionsValid' },
  { from: 'published', to: 'published', guard: 'conditionsValid' },
  { from: 'published', to: 'draft' },
  { from: 'draft', to: 'draft' },
]

/** Approve or deny a status move. Total and deterministic: an unknown (from, to) pair (unrepresentable
 * @public
 *  at the type level for the closed `Status` union) is simply denied, never thrown. */
export function canTransition(from: Status, to: Status, guardResults: Partial<Record<GuardName, boolean>>): boolean {
  const row = transitions.find((r) => r.from === from && r.to === to)
  if (!row) return false
  return row.guard === undefined || guardResults[row.guard] === true
}
