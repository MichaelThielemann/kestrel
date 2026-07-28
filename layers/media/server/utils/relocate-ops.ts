import { eq, inArray, getTableColumns, sql } from 'drizzle-orm'
import { createError, type H3Event } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { media } from '../collections/media'
import { folders } from '../database/folders'
import { isUnder, parentOf, childName, rewritePrefix } from './folder-paths'
import { sanitizeFolder, buildKey, suggestFreeName } from './naming'
import { planRelocateInto, planRename, type ItemPlan } from './relocate-plan'
import { relocateMedia, duplicateMedia } from './storage-relocate'
import { ensureFolder } from './folders'
import { collectAffected, deleteAffected, type OpItem, type AffectedSet } from './media-ops'
import { useStorageDriver, type StorageDriver } from '../../../core/server/utils/storage'
import { escapeLike } from '../../../core/server/utils/sql'

export type OpType = 'move' | 'copy' | 'rename'
export interface MediaOp { type: OpType; items: OpItem[]; dest?: string; name?: string }
export interface Conflict { item: OpItem; targetPath: string; type: 'file-exists' | 'folder-exists' }
export interface RelocationReport { summary: { files: number; folders: number; totalBytes: number }; conflicts: Conflict[] }

/** Parse untrusted request input into well-formed op items (drops malformed entries). */
export function coerceOpItems(raw: unknown): OpItem[] {
  if (!Array.isArray(raw)) return []
  const out: OpItem[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (o.type === 'file' && Number.isInteger(o.id)) out.push({ type: 'file', id: o.id as number })
    else if (o.type === 'folder' && typeof o.path === 'string') {
      // Sanitize at the boundary so the disk cascade (removeDir) targets the same normalized path
      // the DB cascade matches — a raw `..` would diverge them. Empty == root, not a valid item.
      const path = sanitizeFolder(o.path)
      if (path) out.push({ type: 'folder', path })
    }
  }
  return out
}

/** Resolve one op item into its affected set + relocation plan (shared by preview and execute). */
export function planItem(db: BetterSQLite3Database, op: MediaOp, item: OpItem): { affected: AffectedSet; plan: ItemPlan } {
  const affected = collectAffected(db, [item])
  const plan = op.type === 'rename'
    ? planRename(item, affected, op.name ?? '')
    : planRelocateInto(item, affected, op.dest ?? '')
  return { affected, plan }
}

/** Reject malformed ops before any work: empty items, bad rename args, folder-into-itself moves. */
export function validateOp(op: MediaOp): void {
  if (!op.items.length) throw createError({ statusCode: 400, statusMessage: 'No items' })
  if (op.type === 'rename') {
    if (op.items.length !== 1 || !op.name) throw createError({ statusCode: 400, statusMessage: 'Rename needs exactly one item and a name' })
    return
  }
  const dest = sanitizeFolder(op.dest ?? '')
  for (const item of op.items) {
    if (item.type === 'folder' && isUnder(item.path, dest)) {
      throw createError({ statusCode: 400, statusMessage: 'Cannot move a folder into itself' })
    }
  }
}

/** Wave 1 (dryRun): plan the op, then report impact + target-occupancy conflicts. Mutates nothing. */
export function previewRelocation(db: BetterSQLite3Database, op: MediaOp): RelocationReport {
  validateOp(op)
  const planned = op.items.map((item) => ({ item, ...planItem(db, op, item) }))

  const summary = {
    files: planned.reduce((n, p) => n + p.affected.media.length, 0),
    folders: planned.reduce((n, p) => n + p.affected.folders.length, 0),
    totalBytes: planned.reduce((n, p) => n + p.affected.media.reduce((s, m) => s + (m.size || 0), 0), 0),
  }

  // Bounded index lookups instead of materializing the whole media/folders tables: this runs once per
  // item during execute for any onConflict other than 'abort' (applyStrategy re-previews in isolation),
  // so a full scan here is O(items × table size) on a bulk move/copy. Both probed columns are uniquely
  // indexed, so only the keys/paths THIS op's own items could possibly land on ever need checking —
  // the loop below never queries either Set outside that set.
  const probeKeys = new Set<string>()
  const probeRoots = new Set<string>()
  for (const { item, plan } of planned) {
    if (item.type === 'file') {
      const k = plan.media[0]?.toKey
      if (k) probeKeys.add(k)
    } else {
      probeRoots.add(plan.toRoot)
      probeKeys.add(plan.toRoot)
      for (const m of plan.media) probeKeys.add(m.toKey)
    }
  }
  const allKeys = probeKeys.size
    ? new Set((db.select({ k: getTableColumns(media).storageKey }).from(media as AnySQLiteTable)
        .where(inArray(getTableColumns(media).storageKey, [...probeKeys])).all() as { k: string }[]).map((r) => r.k))
    : new Set<string>()
  const allFolderPaths = probeRoots.size
    ? new Set(db.select({ path: folders.path }).from(folders).where(inArray(folders.path, [...probeRoots])).all().map((f) => f.path))
    : new Set<string>()

  // Preview frees all source keys set-wise (order-independent), but execute vacates them one at a time — so a key-rotation batch (move A onto B's key while moving B) can pass preview yet hit relocateMedia's per-key 409 mid-execute; acceptable under the per-item compensating model.
  const frees = op.type === 'copy' ? { keys: new Set<string>(), folders: new Set<string>() } : {
    keys: new Set(planned.flatMap((p) => p.plan.media.map((m) => m.fromKey))),
    folders: new Set(planned.flatMap((p) => p.affected.folders)),
  }
  const isOccupiedKey = (key: string) => allKeys.has(key) && !frees.keys.has(key)
  const isOccupiedFolder = (path: string) => allFolderPaths.has(path) && !frees.folders.has(path)

  // Targets claimed by earlier items in this same op, so two items whose new
  // targets land on the same slot collide (the later one is flagged).
  const claimedKeys = new Set<string>()
  const claimedRoots = new Set<string>()

  const conflicts: Conflict[] = []
  for (const { item, plan } of planned) {
    if (item.type === 'file') {
      const toKey = plan.media[0]?.toKey
      if (toKey && (isOccupiedKey(toKey) || claimedKeys.has(toKey))) conflicts.push({ item, targetPath: toKey, type: 'file-exists' })
    // folder-exists ⇒ the destination subtree is occupied: an existing folder row, a FILE whose key equals the
    // target root (a folder onto a file would mkdir over a file → 500 / DB-vs-disk desync), a descendant file
    // key, or an intra-batch claim.
    } else if (isOccupiedFolder(plan.toRoot) || isOccupiedKey(plan.toRoot) || claimedRoots.has(plan.toRoot) || claimedKeys.has(plan.toRoot) || plan.media.some((m) => isOccupiedKey(m.toKey) || claimedKeys.has(m.toKey))) {
      conflicts.push({ item, targetPath: plan.toRoot, type: 'folder-exists' })
    }
    if (item.type === 'folder') claimedRoots.add(plan.toRoot)
    for (const m of plan.media) claimedKeys.add(m.toKey)
  }
  return { summary, conflicts }
}

export interface OpResult {
  item: OpItem
  status: 'moved' | 'copied' | 'renamed' | 'skipped' | 'overwritten' | 'renamed-auto'
  newPath?: string
}

/** Move/rename folder-item branch: repoint the folder rows in one transaction. */
function relocateFolderRows(db: BetterSQLite3Database, plan: ItemPlan): void {
  db.transaction(() => {
    // Ensure the destination's PARENT chain (not toRoot) first: toRoot is created by re-pathing
    // the source root row, so pre-inserting it would clash on the folders UNIQUE(path).
    ensureFolder(db, parentOf(plan.toRoot) ?? '')
    for (const f of plan.folders) db.update(folders).set({ path: f.to, updatedAt: new Date() }).where(eq(folders.path, f.from)).run()
  })
}

/** Copy folder-item branch: create the destination folder rows. */
function createCopiedFolderRows(db: BetterSQLite3Database, plan: ItemPlan): void {
  for (const f of plan.folders) ensureFolder(db, f.to)
}

/** An item's result plus the media ids it actually LANDED on the target: for a copy those are the rows
 *  `duplicateMedia` created (the source rows never move), for a move/rename the source rows themselves.
 *  Internal to the batch loop — the wire shape stays `OpResult`. */
type ExecutedItem = OpResult & { landedIds: number[] }

/** Execute one already-planned item: relocate/duplicate its media rows and repoint/create its
 *  folder rows. No-op items short-circuit to 'skipped'. */
async function executeItem(
  db: BetterSQLite3Database, driver: StorageDriver, op: MediaOp, item: OpItem, plan: ItemPlan,
): Promise<ExecutedItem> {
  if (plan.media.every((m) => m.toKey === m.fromKey) && plan.folders.every((f) => f.from === f.to)) {
    return { item, status: 'skipped', landedIds: [] }
  }

  if (op.type === 'copy') {
    const landedIds: number[] = []
    for (const m of plan.media) landedIds.push((await duplicateMedia(db, driver, m.id, { folder: m.toFolder, filename: m.toFilename })).id)
    if (item.type === 'folder') {
      createCopiedFolderRows(db, plan)
      for (const f of plan.folders) await driver.ensureDir?.(f.to)
    } else ensureFolder(db, plan.toRoot)
    return { item, status: 'copied', newPath: item.type === 'folder' ? plan.toRoot : plan.media[0].toKey, landedIds }
  }

  for (const m of plan.media) await relocateMedia(db, driver, m.id, { folder: m.toFolder, filename: m.toFilename })
  if (item.type === 'folder') {
    relocateFolderRows(db, plan)
    for (const f of plan.folders) await driver.ensureDir?.(f.to) // dest dirs incl. empty subfolders
    // Clean the vacated source subtree ONLY when nothing unmanaged remains — removeDir is a recursive wipe,
    // so a blind call would destroy non-media objects (extension/consumer blobs) living under the same path.
    const remaining = driver.listPrefix ? await driver.listPrefix(item.path) : ['guard']
    if (remaining.length === 0) await driver.removeDir?.(item.path)
  } else ensureFolder(db, plan.toRoot)
  return {
    item, status: op.type === 'rename' ? 'renamed' : 'moved',
    newPath: item.type === 'folder' ? plan.toRoot : plan.media[0].toKey,
    landedIds: plan.media.map((m) => m.id),
  }
}

/** Wave 2 (execute): re-validate (TOCTOU), then move/copy/rename each item in order, re-planning
 *  per item against the now-mutated db. `abort` rejects 409 up front if any conflict exists. */
export async function executeRelocation(
  db: BetterSQLite3Database, driver: StorageDriver, op: MediaOp,
  onConflict: 'abort' | 'skip' | 'overwrite' | 'rename' = 'abort',
): Promise<OpResult[]> {
  validateOp(op)
  const report = previewRelocation(db, op)
  if (onConflict === 'abort' && report.conflicts.length) {
    throw createError({ statusCode: 409, statusMessage: 'Conflicts prevent the operation', data: report })
  }

  // Ids this batch has already relocated ONTO their target — so a later item's 'overwrite' never treats
  // an earlier item's freshly-landed row as a stale occupant to destroy (see deleteOccupant below).
  const relocatedIds = new Set<number>()
  const results: OpResult[] = []
  for (const item of op.items) {
    const { landedIds, ...result } = await applyStrategy(db, driver, op, item, onConflict, relocatedIds)
    results.push(result)
    for (const id of landedIds) relocatedIds.add(id)
  }
  return results
}

/**
 * Shared body for the move/copy/rename POST handlers (they differ only in the op shape): auth backstop,
 * parse + non-empty-check the items, build the op via `buildOp`, parse `onConflict`, then dispatch a
 * dry-run preview vs a real execute. Each route becomes a one-liner supplying only its op.
 */
export async function runRelocation(event: H3Event, buildOp: (items: OpItem[], body: Record<string, unknown>) => MediaOp) {
  requireAdmin(event)
  const body = (await readBody(event)) as Record<string, unknown> | null
  const items = coerceOpItems(body?.items)
  if (!items.length) throw createError({ statusCode: 400, statusMessage: 'No items' })
  const op = buildOp(items, body ?? {})
  const oc = body?.onConflict
  const onConflict = oc === 'skip' || oc === 'overwrite' || oc === 'rename' ? oc : 'abort'
  const db = useDb()
  if (body?.dryRun === true) return previewRelocation(db, op)
  return executeRelocation(db, useStorageDriver(), op, onConflict)
}

/** Per-item conflict dispatch. Re-checks this item's status against the live db (earlier items in
 *  the batch are already committed), then resolves per `onConflict`. No-Merge: a folder conflict is
 *  handled at the subtree root (skip/overwrite/rename the whole subtree, never per file). */
async function applyStrategy(
  db: BetterSQLite3Database, driver: StorageDriver, op: MediaOp, item: OpItem,
  onConflict: 'abort' | 'skip' | 'overwrite' | 'rename', relocatedIds: Set<number>,
): Promise<ExecutedItem> {
  const conflicts = onConflict === 'abort' ? [] : previewRelocation(db, { ...op, items: [item] }).conflicts
  const { plan } = planItem(db, op, item)

  if (conflicts.length) {
    if (onConflict === 'skip') return { item, status: 'skipped', landedIds: [] }
    if (onConflict === 'overwrite') {
      // Copy/paste into the file's own folder: the "occupant" of the target key IS the source.
      // Overwriting a file with a copy of itself is a no-op — deleting the occupant here would
      // destroy the only copy (executeItem then short-circuits as a no-op and copies nothing).
      const isNoop = plan.media.every((m) => m.toKey === m.fromKey) && plan.folders.every((f) => f.from === f.to)
      if (isNoop) return { item, status: 'skipped', landedIds: [] }
      // The per-item re-preview above sees only the LIVE db, so it can't tell a genuine pre-existing
      // occupant from an earlier item in THIS SAME batch that already landed there — deleting the latter
      // would silently destroy real data this very operation just placed, one item after reporting it
      // as a success. Refuse and skip this item instead (its source is left untouched).
      if (!(await deleteOccupant(db, driver, item, plan, relocatedIds))) return { item, status: 'skipped', landedIds: [] }
      const r = await executeItem(db, driver, op, item, plan)
      return { ...r, status: 'overwritten' }
    }
    const freePlan = freeRenamePlan(db, item, plan)
    const r = await executeItem(db, driver, op, item, freePlan)
    const newPath = item.type === 'file' ? freePlan.media[0]?.toKey : freePlan.toRoot
    return { ...r, status: 'renamed-auto', newPath }
  }

  return executeItem(db, driver, op, item, plan)
}

/** True when no media row currently occupies this storage key. */
function keyIsFree(db: BetterSQLite3Database, key: string): boolean {
  const cols = getTableColumns(media)
  const row = db.select({ id: cols.id }).from(media as AnySQLiteTable).where(eq(cols.storageKey, key)).get()
  return !row
}

/** True when no folders row has this path, no FILE sits exactly at it, AND no media key sits under it. */
function folderRootIsFree(db: BetterSQLite3Database, path: string): boolean {
  const cols = getTableColumns(media)
  const folderRow = db.select({ path: folders.path }).from(folders).where(eq(folders.path, path)).get()
  if (folderRow) return false
  // A file whose storageKey EQUALS this path blocks the folder root too — a folder can't live where a file
  // already is (mkdir over a file 500s; the per-media guard only checks descendant keys, never the root).
  const fileAtRoot = db.select({ id: cols.id }).from(media as AnySQLiteTable).where(eq(cols.storageKey, path)).get()
  if (fileAtRoot) return false
  const descendant = db.select({ id: cols.id }).from(media as AnySQLiteTable)
    .where(sql`${cols.storageKey} like ${`${escapeLike(path)}/%`} escape '\\'`).get()
  return !descendant
}

/** Delete whatever currently occupies the item's target so the move/copy can proceed. No-op if free.
 *  Returns false (refuses to delete) when the occupant is itself a media id THIS SAME BATCH already
 *  relocated onto that target — an intra-batch name collision, not a stale pre-existing occupant. */
async function deleteOccupant(
  db: BetterSQLite3Database, driver: StorageDriver, item: OpItem, plan: ItemPlan, relocatedIds: Set<number>,
): Promise<boolean> {
  // Occupant is deleted before the move commits, so a runtime fault mid-move loses it — inherent to overwrite.
  if (item.type === 'file') {
    const key = plan.media[0]?.toKey
    if (!key) return true
    const cols = getTableColumns(media)
    const row = db.select({ id: cols.id }).from(media as AnySQLiteTable).where(eq(cols.storageKey, key)).get() as { id: number } | undefined
    if (row) {
      if (relocatedIds.has(row.id)) return false
      await deleteAffected(db, driver, [{ type: 'file', id: row.id }], false)
    }
    return true
  }
  const occupant = collectAffected(db, [{ type: 'folder', path: plan.toRoot }])
  if (occupant.media.some((m) => relocatedIds.has(m.id))) return false
  await deleteAffected(db, driver, [{ type: 'folder', path: plan.toRoot }], false)
  return true
}

/** Build a plan whose target is free, for the rename strategy (file → freed filename; folder → freed root). */
function freeRenamePlan(db: BetterSQLite3Database, item: OpItem, plan: ItemPlan): ItemPlan {
  if (item.type === 'file') {
    const m = plan.media[0]
    const name = suggestFreeName(m.toFilename, (n) => keyIsFree(db, buildKey(m.toFolder, n)))
    return { ...plan, media: [{ ...m, toFilename: name, toKey: buildKey(m.toFolder, name) }] }
  }
  const freeRoot = freeFolderRoot(db, plan.toRoot)
  return rebasePlan(plan, plan.toRoot, freeRoot)
}

/** Pick a fresh sibling segment for a colliding folder root: `archive/sub` → `archive/sub-2`. */
function freeFolderRoot(db: BetterSQLite3Database, toRoot: string): string {
  const parent = parentOf(toRoot) ?? ''
  const seg = childName(toRoot)
  const freeSeg = suggestFreeName(seg, (s) => folderRootIsFree(db, parent === '' ? s : `${parent}/${s}`))
  return parent === '' ? freeSeg : `${parent}/${freeSeg}`
}

/** Re-base every target in a folder plan from `from` onto `to` (the whole subtree moves under the new root). */
function rebasePlan(plan: ItemPlan, from: string, to: string): ItemPlan {
  return {
    toRoot: to,
    media: plan.media.map((m) => {
      const toFolder = rewritePrefix(m.toFolder, from, to)
      return { ...m, toFolder, toKey: buildKey(toFolder, m.toFilename) }
    }),
    folders: plan.folders.map((f) => ({ from: f.from, to: rewritePrefix(f.to, from, to) })),
  }
}
