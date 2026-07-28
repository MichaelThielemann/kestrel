import type { WriteEvent } from '../../../core/server/utils/write-events'
import type { DerivativeManifest } from './record'

/** Every storage key a media row owns — the original plus each generated derivative (the webp ladder). */
export function mediaStorageKeys(row: Record<string, unknown>): string[] {
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
 * Storage keys to delete when a write event is a media-record DELETE — the original + ALL derivatives;
 * `[]` for anything else. This makes deleting a media record remove its files on EVERY delete path:
 * the generic CRUD `remove()` emits a delete event handled here, complementing the media library's own
 * `deleteAffected` (which deletes storage inline). So a media record can never be removed while leaving
 * orphaned objects in storage — principle 4 (output ≡ DB) for media. Pure → unit-testable.
 */
export function planMediaDeletion(event: WriteEvent): string[] {
  if (event.def.name !== 'media' || event.after !== null || !event.before) return []
  return mediaStorageKeys(event.before)
}
