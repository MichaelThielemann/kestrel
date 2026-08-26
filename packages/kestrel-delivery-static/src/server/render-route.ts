import { currentSnapshot, usePublishingDb } from '@michaelthielemann/kestrel-publishing'

/**
 * The static delivery adapter's per-route content lookup: reads the route's current published snapshot
 * and hands back its HTML as a body/status pair, in the same shape the producer's live render uses —
 * so the rest of the publisher (write-to-driver, prune, meta) does not need to know which one produced it.
 * No live server round trip, no DB populate: a route with no current snapshot (never published, or
 * retracted — see `retractSnapshot`) is a plain 404, not an error.
 *
 * An intentional seam, not dead code: `publisher.ts` still writes files by rendering live and calling
 * `driver.put` directly rather than through this function, the same not-yet-wired state `deliveryPortFor`
 * documents for the port it belongs to.
 * @public
 */
export function renderRoute(route: string): { body: Buffer | null; status: number } {
  const snapshot = currentSnapshot(usePublishingDb().db, route)
  if (!snapshot) return { body: null, status: 404 }
  return { body: Buffer.from(snapshot.html, 'utf8'), status: 200 }
}
