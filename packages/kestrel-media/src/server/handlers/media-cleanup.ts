import type { EventEnvelope } from '@kestrel/contracts'
import { registerOutboxHandler } from '@kestrel/core'
import type { DerivativeManifest } from '../utils/record.js'
import { useStorageDriver } from '../utils/storage.js'

/** Every storage key a media row owns — the original plus each generated derivative (the webp ladder). */
function mediaStorageKeys(row: Record<string, unknown>): string[] {
  const keys: string[] = []
  if (typeof row.storageKey === 'string' && row.storageKey) keys.push(row.storageKey)
  const derivatives = row.derivatives as DerivativeManifest | null | undefined
  if (derivatives && typeof derivatives === 'object') {
    for (const d of Object.values(derivatives)) {
      if (d && typeof d.key === 'string' && d.key) keys.push(d.key)
    }
  }
  return keys
}

/**
 * Outbox handler for media storage GC. Registered (via {@link registerMediaCleanup}) against the exact
 * `media.deleted` event — the envelope's payload IS the deleted row (both `persist.ts`'s generic CRUD
 * delete and the media library's own synthetic-write outbox seam carry `before` as the payload for a
 * delete), so the keys to remove come straight off it; there is no surviving row left to re-derive from,
 * unlike `reindexRefs`.
 *
 * Idempotent: a storage driver's `delete` on an already-missing key is a no-op (see the local/S3 drivers),
 * so redelivering the same envelope — or a second, independent cleanup of the same keys (the media
 * library's own inline delete in `deleteAffected`) — converges on the same end state without erroring.
 *
 * No error swallowing (ADR-0022/ADR-0023): a storage failure throws, failing this dispatch; the worker
 * retries and then dead-letters, visibly, instead of silently leaving an orphaned object.
 */
async function mediaCleanup(envelope: EventEnvelope): Promise<void> {
  const driver = useStorageDriver()
  const keys = mediaStorageKeys((envelope.payload ?? {}) as Record<string, unknown>)
  await Promise.all(keys.map((key) => driver.delete(key)))
}

/** Registers `mediaCleanup` (this file's own handler) against `media.deleted`. Called once, from the
 *  `05.media-cleanup.ts` plugin's body — not a module-import side effect (mirrors `registerReindexRefs`).
 * @public
 */
export function registerMediaCleanup(): void {
  registerOutboxHandler('mediaCleanup', { event: 'media.deleted' }, mediaCleanup)
}
