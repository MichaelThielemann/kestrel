import type { DeliveryPort } from '@michaelthielemann/kestrel-contracts'

/**
 * The live delivery adapter's `DeliveryPort`: published content is served straight from
 * `published_snapshots` at request time (see `serve.ts`'s catch-all and `pipeline.ts`'s read API), so
 * the write side is a no-op here — `recordSnapshot`/`retractSnapshot` (the publisher's own calls, in
 * `db/snapshots.ts`) are already the persistence, independent of which delivery mode is selected. A
 * `StorageDriver` is deliberately not required: this adapter never writes a file.
 * @public
 */
export function createLiveDeliveryPort(): DeliveryPort {
  return {
    async publishSnapshot() {},
    async removeRoutes() {},
    async rebuildAll(iter) {
      // Drain the iterator so a caller awaiting completion observes it — there is nothing to write.
      for await (const _snapshot of iter) { /* no-op: the store is already the source of truth */ }
    },
  }
}
