import { eq, inArray, or, getTableColumns, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MediaDb } from '../db/media-db.js'
import { findMediaUsagesForMany, type MediaUsage } from './usages.js'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { media } from '../collections/media.js'
import { folders } from '../database/folders.js'
import { isUnder } from './folder-paths.js'
import type { DerivativeManifest } from './record.js'
import { emitMediaOutbox, emitMediaWrite, NO_PIPELINE_CTX } from './media-write.js'
import type { StorageDriver } from '@michaelthielemann/kestrel-core'
import { escapeLike } from '@michaelthielemann/kestrel-core'

/** One target of a bulk media operation: a single file (by id) or a folder (by path, with its descendants).
 * @public
 */
export type OpItem = { type: 'file'; id: number } | { type: 'folder'; path: string }

/** One media row an operation affects.
 * @public
 */
export interface AffectedMedia {
  id: number; storageKey: string; folder: string | null; filename: string
  size: number; derivatives: DerivativeManifest | null
  /** The full row as read off the table — kept alongside the named projection above (rather than replacing
   *  it, since call sites destructure the named fields directly) so a consumer with a use for the rest of
   *  the row (the outbox envelope payload `deleteAffected` emits) doesn't force a second read for it. */
  raw: Record<string, unknown>
}
/** The concrete rows an operation's `OpItem`s resolve to.
 * @public
 */
export interface AffectedSet { media: AffectedMedia[]; folders: string[] }

/** Resolve op items into the concrete affected media rows + folder paths. A `folder` item
 *  expands to itself + every descendant (media + folder rows). Folders are returned deepest-first
 *  (so a delete removes children before parents); media is deduped by id.
 * @public
 */
export function collectAffected(db: MediaDb, items: OpItem[]): AffectedSet {
  const cols = getTableColumns(media) as Record<string, never>
  const t = media as AnySQLiteTable
  const mediaById = new Map<number, AffectedMedia>()
  const folderSet = new Set<string>()
  // Only a folder item ever consults the full folder list (to find its descendants) — an all-file list
  // never touches it, so skip the read rather than materialize every row for nothing.
  const allFolders = items.some((i) => i.type === 'folder')
    ? db.select({ path: folders.path }).from(folders).all().map((f) => f.path)
    : []

  const add = (rows: Record<string, unknown>[]) => {
    for (const r of rows) mediaById.set(r.id as number, {
      id: r.id as number, storageKey: r.storageKey as string, folder: (r.folder as string | null) ?? null,
      filename: r.filename as string, size: r.size as number, derivatives: (r.derivatives as DerivativeManifest | null) ?? null,
      raw: r,
    })
  }

  for (const item of items) {
    if (item.type === 'file') {
      const row = db.select().from(t).where(eq(cols.id, item.id)).get() as Record<string, unknown> | undefined
      if (row) add([row])
    } else {
      for (const fp of allFolders) if (isUnder(item.path, fp)) folderSet.add(fp)
      folderSet.add(item.path)
      const rows = db.select().from(t).where(
        or(eq(cols.folder, item.path), sql`${cols.folder} like ${`${escapeLike(item.path)}/%`} escape '\\'`),
      ).all() as Record<string, unknown>[]
      add(rows)
    }
  }

  const folderList = [...folderSet].sort((a, b) => b.split('/').length - a.split('/').length)
  return { media: [...mediaById.values()], folders: folderList }
}

// findMediaUsagesForMany scans every OTHER collection's table for reverse references to a media id — a
// structural cross-module read, so it stays on the unrestricted db rather than the media-scoped MediaDb.
// Owner: content (see the exemption note above findMediaUsagesForMany in usages.ts — record_refs now
// covers this under the content manifest, but not the plain-`json`-field over-approximation this scan
// also does, so the swap is deliberately not made here yet).
/** Reverse-usage lookup for many media ids at once: id -\> the records referencing it.
 * @public
 */
export function bulkUsages(db: BetterSQLite3Database, ids: number[]): Record<number, MediaUsage[]> {
  return findMediaUsagesForMany(db, ids)
}

/** Impact report for a delete: what would be (or was) affected, and any storage failures.
 * @public
 */
export interface DeleteReport {
  summary: { files: number; folders: number; totalBytes: number }
  usages?: Record<number, MediaUsage[]>
  /** storageKeys whose blob delete failed — the row is already gone (rows commit before storage), so a
   *  failure here is an orphaned object, not a retryable half-delete; surfaced for the caller to log/alert. */
  failedKeys?: string[]
}

/** Dry-run report: impact + per-media usages, no mutation. Split out from {@link deleteAffected} because
 *  the usages lookup needs the unrestricted db (see `bulkUsages`) while the real delete stays entirely
 *  inside media's own tables.
 * @public
 */
export function previewDelete(db: MediaDb, usagesDb: BetterSQLite3Database, items: OpItem[]): DeleteReport {
  const affected = collectAffected(db, items)
  const summary = {
    files: affected.media.length,
    folders: affected.folders.length,
    totalBytes: affected.media.reduce((n, m) => n + (m.size || 0), 0),
  }
  return { summary, usages: bulkUsages(usagesDb, affected.media.map((m) => m.id)) }
}

/** Delete all affected media rows + folder rows in one transaction, then delete the storage objects
 *  (original + derivatives). Folder cascade included. For the dry-run report, see {@link previewDelete}.
 * @public
 */
export async function deleteAffected(
  db: MediaDb, driver: StorageDriver, items: OpItem[],
): Promise<DeleteReport> {
  const affected = collectAffected(db, items)
  const summary = {
    files: affected.media.length,
    folders: affected.folders.length,
    totalBytes: affected.media.reduce((n, m) => n + (m.size || 0), 0),
  }

  const cols = getTableColumns(media) as Record<string, never>
  const mediaIds = affected.media.map((m) => m.id)
  db.transaction((tx) => {
    if (mediaIds.length) tx.delete(media).where(inArray(cols.id, mediaIds)).run()
    if (affected.folders.length) tx.delete(folders).where(inArray(folders.path, affected.folders)).run()
    // Same transaction as the row deletes: the outbox row and the rows it describes land or roll back
    // together (see emitMediaOutbox's TSDoc). `m.raw` is the full row `collectAffected` already read —
    // passed as-is rather than the narrower named-field projection, so a consumer reading `media.deleted`
    // off the outbox gets the same shape a real CRUD delete's envelope would carry.
    for (const m of affected.media) emitMediaOutbox(db, m.raw, null, NO_PIPELINE_CTX)
  })

  // Best-effort per item: the rows are already committed gone, so a storage error here means an orphan
  // object, not a rollback candidate — one bad key (a throttled/5xx S3 call) must not abort the loop and
  // leave every LATER item's blobs undeleted too with no row left to find them again.
  const failedKeys: string[] = []
  for (const m of affected.media) {
    try {
      await driver.delete(m.storageKey)
      for (const d of Object.values(m.derivatives ?? {})) await driver.delete(d.key)
    } catch (error) {
      console.error(`[kestrel] media storage delete failed for ${m.storageKey}:`, (error as Error)?.message ?? error)
      failedKeys.push(m.storageKey)
    }
    emitMediaWrite({ id: m.id }, null) // deleted media → re-render listings that query it
  }
  // Clean up the folder dir ONLY when nothing unmanaged remains under it. removeDir is a recursive subtree
  // wipe, so a blind call would destroy any non-media object living under the same path — e.g. an extension's
  // encrypted blob namespace, or any consumer blob written via useStorageDriver — which no media row (and no
  // dryRun count) accounts for. If anything is still there, leave the whole path alone.
  for (const it of items) {
    if (it.type !== 'folder') continue
    const remaining = driver.listPrefix ? await driver.listPrefix(it.path) : ['guard']
    if (remaining.length === 0) await driver.removeDir?.(it.path)
  }
  return failedKeys.length ? { summary, failedKeys } : { summary }
}
