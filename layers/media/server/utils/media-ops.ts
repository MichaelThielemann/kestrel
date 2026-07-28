import { eq, inArray, or, getTableColumns, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { findMediaUsagesForMany, type MediaUsage } from './usages'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { media } from '../collections/media'
import { folders } from '../database/folders'
import { isUnder } from './folder-paths'
import type { DerivativeManifest } from './record'
import { emitMediaWrite } from './media-write'
import type { StorageDriver } from '../../../core/server/utils/storage'
import { escapeLike } from '../../../core/server/utils/sql'

export type OpItem = { type: 'file'; id: number } | { type: 'folder'; path: string }

export interface AffectedMedia {
  id: number; storageKey: string; folder: string | null; filename: string
  size: number; derivatives: DerivativeManifest | null
}
export interface AffectedSet { media: AffectedMedia[]; folders: string[] }

/** Resolve op items into the concrete affected media rows + folder paths. A `folder` item
 *  expands to itself + every descendant (media + folder rows). Folders are returned deepest-first
 *  (so a delete removes children before parents); media is deduped by id. */
export function collectAffected(db: BetterSQLite3Database, items: OpItem[]): AffectedSet {
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

/** Reverse-usage lookup for many media ids at once: id -> the records referencing it. */
export function bulkUsages(db: BetterSQLite3Database, ids: number[]): Record<number, MediaUsage[]> {
  return findMediaUsagesForMany(db, ids)
}

export interface DeleteReport {
  summary: { files: number; folders: number; totalBytes: number }
  usages?: Record<number, MediaUsage[]>
  /** storageKeys whose blob delete failed — the row is already gone (rows commit before storage), so a
   *  failure here is an orphaned object, not a retryable half-delete; surfaced for the caller to log/alert. */
  failedKeys?: string[]
}

/** Two-wave delete. dryRun → report impact + per-media usages, no mutation. Otherwise → delete
 *  all affected media rows + folder rows in one transaction, then delete the storage objects
 *  (original + derivatives). Folder cascade included. */
export async function deleteAffected(
  db: BetterSQLite3Database, driver: StorageDriver, items: OpItem[], dryRun: boolean,
): Promise<DeleteReport> {
  const affected = collectAffected(db, items)
  const summary = {
    files: affected.media.length,
    folders: affected.folders.length,
    totalBytes: affected.media.reduce((n, m) => n + (m.size || 0), 0),
  }
  if (dryRun) return { summary, usages: bulkUsages(db, affected.media.map((m) => m.id)) }

  const cols = getTableColumns(media) as Record<string, never>
  const mediaIds = affected.media.map((m) => m.id)
  db.transaction((tx) => {
    if (mediaIds.length) tx.delete(media).where(inArray(cols.id, mediaIds)).run()
    if (affected.folders.length) tx.delete(folders).where(inArray(folders.path, affected.folders)).run()
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
