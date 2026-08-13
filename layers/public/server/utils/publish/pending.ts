/**
 * "Saved but not published": the state a deferred-publish model needs to name. Saving writes the DB,
 * publishing writes the static file, so the two stamps drift apart on purpose — a record edited after its
 * page was last published keeps serving the published version until someone publishes again.
 *
 * The tolerance is not cosmetic: `publish_status.updated_at` is stored in whole seconds while a record's
 * `updatedAt` is milliseconds, so the publish that directly followed a save can carry a stamp up to a
 * second BEHIND it. Without the slack every freshly published page would report unpublished changes.
 */
const TOLERANCE_MS = 1000

export function hasPendingChanges(savedAtMs: number | null | undefined, publishedAtMs: number | null | undefined, toleranceMs = TOLERANCE_MS): boolean {
  // Never published (no status row) → nothing to protect: there is no older artifact this edit could
  // overtake, so the route is a normal render candidate, not a pending change.
  if (savedAtMs == null || publishedAtMs == null) return false
  return savedAtMs > publishedAtMs + toleranceMs
}

/** The subset of `savedAt` routes whose record moved on after the route's last publish. Pure. */
export function pendingRoutes(savedAt: Map<string, number>, publishedAt: Map<string, number>): string[] {
  const out: string[] = []
  for (const [route, saved] of savedAt) {
    if (hasPendingChanges(saved, publishedAt.get(route) ?? null)) out.push(route)
  }
  return out
}
