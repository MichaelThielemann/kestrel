import { eq, getTableColumns } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { media } from '../collections/media'
import { derivativeKey, withPreservedTranslations, type DerivativeManifest } from './record'
import type { DerivedImage } from './derive'
import type { StorageDriver } from '../../../core/server/utils/storage'
import type { Translations } from './translations'

// Long-lived (non-immutable, so a replace isn't pinned) cache for originals + derivatives — effective on
// the S3 driver, ignored by the local driver (NGINX owns its cache). Mirrors the header in backfill.ts.
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000'

export interface PersistArgs {
  storageKey: string
  bytes: Buffer
  mime: string
  derived?: DerivedImage
  values: Record<string, unknown>
  existing?: { id: number; derivatives?: DerivativeManifest; translations?: Translations }
  overwrite: boolean
}

/**
 * Write the original + derivative objects and insert/update the media row. On the CREATE path (no
 * pre-existing row) a failure at ANY step removes every blob written during the attempt — otherwise a
 * partial write (an S3 hiccup mid-derivative, a lost INSERT race) strands orphan blobs that permanently
 * 409-block the filename (overwrite can't reclaim a row-less key, and no reconcile removes them). The
 * OVERWRITE path leaves the (pre-existing) original in place on failure — it was there before this upload.
 */
export async function persistUpload(db: BetterSQLite3Database, driver: StorageDriver, args: PersistArgs): Promise<Record<string, unknown>> {
  const { storageKey, bytes, mime, derived, values, existing, overwrite } = args
  const cols = getTableColumns(media) as Record<string, never>
  const isOverwrite = !!(existing && overwrite)
  const derivKeys = (derived?.variants ?? []).map((v) => derivativeKey(storageKey, v.name, v.format))

  try {
    await driver.put(storageKey, bytes, mime, { cacheControl: MEDIA_CACHE_CONTROL })
    for (const v of derived?.variants ?? []) {
      await driver.put(derivativeKey(storageKey, v.name, v.format), v.bytes, v.mime, { cacheControl: MEDIA_CACHE_CONTROL })
    }
    if (isOverwrite) {
      // Drop any old derivative objects the new manifest no longer references, then update the row.
      const newKeys = new Set(Object.values(values.derivatives as DerivativeManifest).map((d) => d.key))
      for (const old of Object.values(existing!.derivatives ?? {})) {
        if (!newKeys.has(old.key)) await driver.delete(old.key)
      }
      // Re-read translations fresh, right before the merge — `existing` was captured by the caller BEFORE
      // the (potentially slow) driver.put calls above; a concurrent alt-text PATCH landing during that
      // window would otherwise be silently reverted by merging the pre-I/O snapshot.
      const fresh = db.select({ translations: cols.translations }).from(media)
        .where(eq(cols.storageKey, storageKey)).get() as { translations?: Translations } | undefined
      return db.update(media).set({ ...withPreservedTranslations(values, fresh ?? existing), updatedAt: new Date() })
        .where(eq(cols.storageKey, storageKey)).returning().get() as Record<string, unknown>
    }
    return db.insert(media).values(values as never).returning().get() as Record<string, unknown>
  } catch (error) {
    if (!isOverwrite) {
      for (const k of [storageKey, ...derivKeys]) await driver.delete(k).catch(() => {})
    }
    throw error
  }
}
