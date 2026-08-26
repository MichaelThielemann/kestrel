// Storage GC for gallery namespaces. When a record holding a `secureGallery` is deleted (or its gallery is
// replaced/cleared), recursively remove `galleries-secure/<galleryId>/` so blobs + the index never orphan
// (output ≡ storage, on every path). Fire-and-forget; removeDir is idempotent, errors logged. Mirrors the
// media-cleanup plugin. `planGalleryDeletion` / `referencedGalleryIds` (this layer) are auto-imported.
import { Effect } from 'effect'
import { registerAfterStep, eventsOf, useDb, allCollections } from '@michaelthielemann/kestrel-core'
import { useStorageDriver } from '@michaelthielemann/kestrel-media'

export default defineNitroPlugin(() => {
  registerAfterStep({
    critical: false,
    step: {
      name: 'galleryCleanup',
      fn: (ctx) => Effect.sync(() => {
        for (const event of eventsOf(ctx)) {
          const ids = planGalleryDeletion(event)
          if (!ids.length) continue
          const driver = useStorageDriver()
          if (typeof driver.removeDir !== 'function') {
            // Surface the orphaning instead of silently no-op'ing — the gallery blobs + index stay behind.
            console.warn(`[kestrel] galleries-secure: storage driver has no removeDir(); ${ids.length} gallery namespace(s) left orphaned on record delete/replace`)
            continue
          }
          // Ownership guard: never removeDir a galleryId another LIVE row still references (a shared ref, e.g. a
          // verbatim multilingual copy) — that would delete the other record's blobs. Fail-safe: on any scan
          // error, treat every id as in-use → skip deletion (an orphaned namespace is recoverable; deleting
          // live data isn't).
          let inUse: Set<string>
          try { inUse = referencedGalleryIds(useDb(), allCollections()) }
          catch (error) { console.error('[kestrel] gallery ownership scan failed; skipping cleanup:', error); continue }
          const toDelete = ids.filter((id) => !inUse.has(id))
          if (!toDelete.length) continue
          void Promise.all(toDelete.map((id) => driver.removeDir!(`galleries-secure/${id}`)))
            .catch((error) => console.error('[kestrel] gallery storage cleanup failed:', error))
        }
      }),
    },
  })
})
