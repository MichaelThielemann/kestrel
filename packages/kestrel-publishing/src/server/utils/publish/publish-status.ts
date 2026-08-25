import { eq } from 'drizzle-orm'
import { OwnershipViolation, type ModuleDbBrand } from '@kestrel/core'
import { publishStatus } from '../../database/publish-status.js'
import type { PublishingDb } from '../../db/publishing-db.js'

/** The narrow slice of `PublishingDb` this module needs. `Pick<T, K>` drops every key outside `K`,
 *  including the brand — re-intersected explicitly (mirrors `record-ref-index.ts`'s own `DB`/`WriteDB`/
 *  `RebuildDB`), so a raw `BetterSQLite3Database`/drizzle instance still fails to structurally satisfy
 *  this narrowed type; only a real, ownership-checked `PublishingDb` does. This module's own unit tests
 *  cast a raw in-memory db at the crossing (`as unknown as PublishStatusDb`), mirroring
 *  `record-ref-index.test.ts`'s own `asContentDb` helper.
 * @public
 */
export type PublishStatusDb = Pick<PublishingDb, 'select' | 'insert' | 'delete'> & { readonly [ModuleDbBrand]: true }

/** The outcome {@link recordPublishStatus} records for one route's publish attempt.
 * @public
 */
export interface PublishOutcome {
  status: 'success' | 'error'
  /** The failure message (render / write / S3) on an 'error' outcome; omitted/null on success. */
  error?: string | null
  /** Which output the attempt wrote to — `outputConfig().driver` ('local' | 's3'). */
  target: string
}

/**
 * Upsert the LATEST publish outcome for a route — one row per route (latest-state, not a history). Called
 * by the runtime publisher after each render+put (success) or when one throws (error). Resilient by design:
 * a missing `publish_status` table (a not-yet-migrated deploy — prod never auto-DDLs) degrades to a warn
 * rather than breaking the publish loop or masking the real render/write error in the caller's catch. The
 * timestamp is an explicit `new Date()` so the conflict-update branch (which does not fire `$defaultFn`)
 * also refreshes it; drizzle maps it to UNIX seconds (mode:'timestamp'), never raw milliseconds.
 * @public
 */
export function recordPublishStatus(db: PublishStatusDb, route: string, outcome: PublishOutcome): void {
  try {
    const set = { status: outcome.status, error: outcome.error ?? null, target: outcome.target, updatedAt: new Date() }
    db.insert(publishStatus).values({ route, ...set }).onConflictDoUpdate({ target: publishStatus.route, set }).run()
  } catch (error) {
    if (error instanceof OwnershipViolation) throw error
    console.warn('[kestrel] could not record publish status (is `publish_status` migrated? run `db:migrate`):', (error as Error).message)
  }
}

/**
 * Classify a route's render result into a publish outcome:
 *  - `success` — a 200 with a rendered body (write it + record success).
 *  - `error`   — a 5xx: the page itself rendered to a server error (a bad block / relation / template).
 *                Crucially this surfaces as a non-200 RESPONSE, not a thrown exception, so without this
 *                branch it would be a silent skip leaving a stale `success` row — the failure mode the
 *                editor ampel most needs to show.
 *  - `skip`    — any other non-200 (a draft / unpublish race resolving to a 404 / redirect): not an error,
 *                leave the route's status untouched (the prune path handles a real unpublish).
 * @public
 */
export function renderOutcome(status: number, hasBody: boolean): 'success' | 'error' | 'skip' {
  if (status === 200 && hasBody) return 'success'
  if (status >= 500) return 'error'
  return 'skip'
}

/**
 * Every route's last successful-or-failed publish time, in ms — the "last published" half of the
 * saved-vs-published comparison a deferred publish needs. Same missing-table resilience as the writers:
 * an unmigrated deploy yields an empty map, which reads as "nothing was ever published here" and so
 * holds nothing back.
 * @public
 */
export function lastPublishedAt(db: PublishStatusDb): Map<string, number> {
  const out = new Map<string, number>()
  try {
    for (const row of db.select({ route: publishStatus.route, updatedAt: publishStatus.updatedAt }).from(publishStatus).all()) {
      if (row.updatedAt instanceof Date) out.set(row.route, row.updatedAt.getTime())
    }
  } catch (error) {
    if (error instanceof OwnershipViolation) throw error
    console.warn('[kestrel] could not read publish status:', (error as Error).message)
  }
  return out
}

/** Clear a route's status row — its static file was pruned (unpublish / delete / slug change), so it is no
 *  longer live. Idempotent; same missing-table resilience as `recordPublishStatus`.
 * @public
 */
export function clearPublishStatus(db: PublishStatusDb, route: string): void {
  try {
    db.delete(publishStatus).where(eq(publishStatus.route, route)).run()
  } catch (error) {
    if (error instanceof OwnershipViolation) throw error
    console.warn('[kestrel] could not clear publish status:', (error as Error).message)
  }
}
