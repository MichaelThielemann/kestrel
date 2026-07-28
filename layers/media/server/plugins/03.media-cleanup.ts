import { registerWriteListener } from '../../../core/server/utils/write-events'
import { planMediaDeletion } from '../utils/media-cleanup'
import { useStorageDriver } from '../../../core/server/utils/storage'

/**
 * Storage GC for media-record deletes. The media library's own `deleteAffected` deletes storage inline
 * (and bypasses the write bus); this covers EVERY OTHER delete path — the generic CRUD `remove()`, which
 * emits a delete event — by removing the row's original + all derivatives from storage. So a media record
 * is never removed while leaving orphaned files: principle 4 (output ≡ DB) for media, on every path.
 * Fire-and-forget (best-effort, like the publisher); the driver's delete is idempotent, errors are logged.
 */
export default defineNitroPlugin(() => {
  registerWriteListener((event) => {
    const keys = planMediaDeletion(event)
    if (!keys.length) return
    const driver = useStorageDriver()
    void Promise.all(keys.map((key) => driver.delete(key)))
      .catch((error) => console.error('[kestrel] media storage cleanup failed:', error))
  })
})
