import type { DeliveryPort, PublishedSnapshot } from '@kestrel/contracts'
import type { StorageDriver } from '@kestrel/core'
import { contentTypeFor, cacheControlFor } from '@kestrel/core'
import { createLiveDeliveryPort } from '@kestrel/delivery-live'
import { htmlKeyForRoute } from '@kestrel/publishing'

/**
 * The static delivery adapter's `DeliveryPort` (ADR-0013 §3.3): writes/prunes files through a
 * `StorageDriver` (local dir or S3) — the same output the runtime publisher and the build-time deploy have
 * always written to. `publishSnapshot`/`rebuildAll` take the snapshot's `html` as-is (already fully
 * populated, media fixed by the producer at snapshot-creation time) and never re-render or touch the DB.
 * @public
 */
export function createStaticDeliveryPort(driver: StorageDriver): DeliveryPort {
  async function writeSnapshot(snapshot: PublishedSnapshot): Promise<void> {
    const key = htmlKeyForRoute(snapshot.route)
    await driver.put(key, Buffer.from(snapshot.html, 'utf8'), contentTypeFor(key), { cacheControl: cacheControlFor(key) })
  }

  return {
    async publishSnapshot(snapshot) {
      await writeSnapshot(snapshot)
    },
    async removeRoutes(routes) {
      for (const route of routes) {
        await driver.delete(htmlKeyForRoute(route), { pruneEmptyDirs: true })
      }
    },
    async rebuildAll(iter) {
      for await (const snapshot of iter) {
        await writeSnapshot(snapshot)
      }
    },
  }
}

/**
 * The `delivery` config selection seam (`kestrel.delivery: 'static' | 'live'`, default `'static'` —
 * see `resolveKestrel`): `'static'` returns the file-backed adapter above, `'live'` returns
 * `delivery-live`'s adapter (serves `published_snapshots` at request time instead of writing files —
 * see `createLiveDeliveryPort`'s own TSDoc). The runtime publisher/queue do not construct `DeliveryPort`s
 * directly yet (they still write through `StorageDriver` in `publisher.ts`, and that keeps running under
 * `'live'` too — see `KestrelConfig.delivery`), so nothing calls this seam in production yet.
 * @public
 */
export function deliveryPortFor(delivery: 'static' | 'live', driver: StorageDriver): DeliveryPort {
  if (delivery === 'live') return createLiveDeliveryPort()
  return createStaticDeliveryPort(driver)
}
