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

export interface HeldRoutes {
  /** Routes to leave un-rendered: their record is serving an older published version somewhere. */
  hold: Set<string>
  /** Previously-published routes that are still the live artifact of a held record — never prune these. */
  keep: Set<string>
}

/**
 * Withholding by RECORD rather than by route string, which is what a rename needs. `pendingRoutes` compares
 * a route against its own publish stamp, so a renamed record — whose new route has no stamp at all — falls
 * through the "never published, nothing to protect" carve-out: the unpublished rename gets rendered and the
 * old route, still the live one, is left looking abandoned to the prune. The carve-out is about a FIRST
 * deploy having no older version; a rename has one, at the previous route.
 *
 * So a record's prior published routes are consulted too: if the record has moved on since the newest of
 * them, the new route is held back and those prior routes are protected from the prune. A record with no
 * prior published route keeps the carve-out — otherwise a first deploy would produce an empty site.
 *
 * Pure: `routesForTag` is the deps index's lookup, passed in.
 */
export function heldRoutes(
  savedAt: Map<string, number>,
  publishedAt: Map<string, number>,
  recordTag: Map<string, string>,
  routesForTag: (tag: string) => Iterable<string>,
  toleranceMs = TOLERANCE_MS,
): HeldRoutes {
  const hold = new Set<string>()
  const keep = new Set<string>()
  for (const [route, saved] of savedAt) {
    const own = publishedAt.get(route) ?? null
    if (own != null) {
      if (hasPendingChanges(saved, own, toleranceMs)) hold.add(route)
      continue
    }
    // No stamp of its own: either genuinely never published, or published under a previous route.
    const tag = recordTag.get(route)
    if (!tag) continue
    const priors = [...routesForTag(tag)].filter((r) => r !== route && publishedAt.has(r))
    if (!priors.length) continue // first publish of this record — nothing to protect
    const newest = Math.max(...priors.map((r) => publishedAt.get(r)!))
    if (!hasPendingChanges(saved, newest, toleranceMs)) continue
    hold.add(route)
    for (const prior of priors) keep.add(prior)
  }
  return { hold, keep }
}
