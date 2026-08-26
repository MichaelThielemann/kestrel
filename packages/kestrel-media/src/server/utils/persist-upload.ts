import { eq, getTableColumns } from 'drizzle-orm'
import type { MediaDb } from '../db/media-db.js'
import { media } from '../collections/media.js'
import { derivativeKey, withPreservedTranslations, type DerivativeManifest } from './record.js'
import type { DerivedImage } from './derive.js'
import type { StorageDriver } from '@michaelthielemann/kestrel-core'
import type { Translations } from './translations.js'
import { emitMediaOutbox, type EmitFacts, type NO_PIPELINE_CTX } from './media-write.js'

// Long-lived (non-immutable, so a replace isn't pinned) cache for originals + derivatives — effective on
// the S3 driver, ignored by the local driver (NGINX owns its cache). Mirrors the header in backfill.ts.
/** `Cache-Control` header value written for every media original/derivative object. */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000'

/** Everything `persistUpload` needs to write an original + derivatives and insert/update its row. */
export interface PersistArgs {
  storageKey: string
  bytes: Buffer
  mime: string
  derived?: DerivedImage
  values: Record<string, unknown>
  /** The full pre-existing row (a plain `.select()` off `media`) on an overwrite — not narrowed to just the
   *  fields this module reads, so it can be forwarded whole to `emitMediaOutbox` as the real `before`. */
  existing?: Record<string, unknown> & { id: number; derivatives?: DerivativeManifest; translations?: Translations }
  overwrite: boolean
  /** The caller's own pipeline `ctx.facts`, for the overwrite-row outbox envelope (see `emitMediaOutbox`'s
   *  TSDoc) — `NO_PIPELINE_CTX` for a caller with no live `ctx` (none currently; `buildMediaUploadPipeline`
   *  always has one). Required, not optional: forwarded to `emitMediaOutbox` as-is, whose own signature
   *  makes the same brand mandatory rather than silently defaulting. */
  facts: EmitFacts | typeof NO_PIPELINE_CTX
}

/**
 * Write the original + derivative objects and insert/update the media row. On the CREATE path (no
 * pre-existing row) a failure at ANY step removes every blob written during the attempt — otherwise a
 * partial write (an S3 hiccup mid-derivative, a lost INSERT race) strands orphan blobs that permanently
 * 409-block the filename (overwrite can't reclaim a row-less key, and no reconcile removes them). The
 * OVERWRITE path leaves the (pre-existing) original in place on failure — it was there before this upload.
 */
export async function persistUpload(db: MediaDb, driver: StorageDriver, args: PersistArgs): Promise<Record<string, unknown>> {
  const { storageKey, bytes, mime, derived, values, existing, overwrite, facts } = args
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
      // The row update and its outbox row land or roll back together (see emitMediaOutbox's TSDoc).
      // `updated` can come back `undefined` if the row vanished between the read above and this
      // transaction (a concurrent delete) — guarded, not emitted, rather than misclassifying a
      // nonexistent record as `media.updated`.
      return db.transaction((tx) => {
        const updated = tx.update(media).set({ ...withPreservedTranslations(values, fresh ?? existing), updatedAt: new Date() })
          .where(eq(cols.storageKey, storageKey)).returning().get() as Record<string, unknown> | undefined
        if (updated) emitMediaOutbox(db, existing!, updated, facts)
        return updated
      }) as Record<string, unknown>
    }
    return db.insert(media).values(values as never).returning().get() as Record<string, unknown>
  } catch (error) {
    if (!isOverwrite) {
      for (const k of [storageKey, ...derivKeys]) await driver.delete(k).catch(() => {})
    }
    throw error
  }
}
