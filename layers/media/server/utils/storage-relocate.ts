import { eq, getTableColumns } from 'drizzle-orm'
import { createError } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildKey } from './naming'
import { derivativeKey, type DerivativeManifest } from './record'
import { media } from '../collections/media'
import { emitMediaWrite } from './media-write'
import type { StorageDriver } from '../../../core/server/utils/storage'
import { withLock, mediaLockKey } from '../../../core/server/utils/key-lock'

export interface RelocatePlan {
  storageKey: string
  derivatives: DerivativeManifest
  copies: { src: string; dst: string }[]
}

/** Pure: compute the new storageKey, the rewritten derivative manifest, and the list of object
 *  copies (original + each derivative) for moving/renaming a media row to `folder`/`filename`. */
export function planObjectRelocation(
  row: { storageKey: string; derivatives: DerivativeManifest | null },
  folder: string,
  filename: string,
): RelocatePlan {
  const storageKey = buildKey(folder, filename)
  const derivatives: DerivativeManifest = {}
  const copies: { src: string; dst: string }[] = [{ src: row.storageKey, dst: storageKey }]
  for (const [manifestKey, entry] of Object.entries(row.derivatives ?? {})) {
    // manifestKey is `<name>.<format>`; variant names are `[A-Za-z0-9_-]` (no dots), so the LAST dot
    // splits name from format cleanly — rebuild the destination key from the name, not the (now-absent
    // from the key scheme) width.
    const dot = manifestKey.lastIndexOf('.')
    const name = dot > 0 ? manifestKey.slice(0, dot) : manifestKey
    const format = dot > 0 ? manifestKey.slice(dot + 1) : (entry.mime.split('/').pop() ?? 'bin')
    const dst = derivativeKey(storageKey, name, format)
    derivatives[manifestKey] = { ...entry, key: dst }
    copies.push({ src: entry.key, dst })
  }
  return { storageKey, derivatives, copies }
}

interface MediaRowLite { id: number; storageKey: string; folder: string | null; filename: string; derivatives: DerivativeManifest | null }

function mediaCols() { return getTableColumns(media) as Record<string, never> }

/** Reject if any destination object already exists on disk (e.g. another media's derivative, which
 *  carries no `storageKey` row, so the DB clash check misses it). Keys the plan itself vacates are
 *  excluded so a plain move never collides with its own source. */
async function assertDestKeysFree(driver: StorageDriver, plan: RelocatePlan): Promise<void> {
  const sources = new Set(plan.copies.map((c) => c.src))
  for (const c of plan.copies) {
    if (sources.has(c.dst)) continue
    if (await driver.exists?.(c.dst)) {
      throw createError({ statusCode: 409, statusMessage: `A file already exists at ${c.dst}` })
    }
  }
}

/** Move and/or rename a media object (+ its derivatives). Pre-checks the destination key (409 if
 *  taken), copies to the new keys, updates the row, then deletes the old keys; on a DB failure the
 *  freshly-copied objects are removed so the source is never lost. No-op if the target equals the
 *  current key. */
export async function relocateMedia(
  db: BetterSQLite3Database, driver: StorageDriver, id: number,
  target: { folder?: string; filename?: string },
): Promise<void> {
  const cols = mediaCols()
  const row = db.select().from(media).where(eq(cols.id, id)).get() as MediaRowLite | undefined
  if (!row) throw createError({ statusCode: 404, statusMessage: `media ${id} not found` })

  const folder = target.folder ?? row.folder ?? ''
  const filename = target.filename ?? row.filename
  const plan = planObjectRelocation(row, folder, filename)
  if (plan.storageKey === row.storageKey) return

  // Same lock the upload path holds across its own exists-check → put → insert (mediaLockKey, keyed on
  // the DESTINATION key only): without it, a concurrent upload or another relocate targeting this same
  // key can observe it free mid-way through this one and land on top of it — or, two relocates racing
  // for the same destination, have the loser's failure-compensation delete the WINNER's just-landed blob.
  await withLock(mediaLockKey(plan.storageKey), async () => {
    const clash = db.select({ id: cols.id }).from(media).where(eq(cols.storageKey, plan.storageKey)).get() as { id: number } | undefined
    if (clash) throw createError({ statusCode: 409, statusMessage: `A file already exists at ${plan.storageKey}` })
    await assertDestKeysFree(driver, plan)

    for (const c of plan.copies) await driver.copy(c.src, c.dst)
    try {
      db.update(media).set({ storageKey: plan.storageKey, folder: folder || null, filename, derivatives: plan.derivatives, updatedAt: new Date() }).where(eq(cols.id, id)).run()
    } catch (error) {
      for (const c of plan.copies) await driver.delete(c.dst)
      throw error
    }
    for (const c of plan.copies) await driver.delete(c.src)
  })
  // The public URL is built from storageKey — moving/renaming changes it, so embedding pages must re-render.
  emitMediaWrite({ id }, { id })
}

interface MediaRowFull extends MediaRowLite {
  mime: string; ext: string; size: number; width: number | null; height: number | null
  checksum: string | null; thumbhash: string | null
  translations: Record<string, unknown> | null
}

/** Duplicate a media object (+ derivatives) to a new key and insert a new row (same bytes →
 *  same checksum/dims/translations). Rejects 409 if the target key is taken. */
export async function duplicateMedia(
  db: BetterSQLite3Database, driver: StorageDriver, id: number,
  target: { folder?: string; filename?: string },
): Promise<{ id: number }> {
  const cols = mediaCols()
  const row = db.select().from(media).where(eq(cols.id, id)).get() as MediaRowFull | undefined
  if (!row) throw createError({ statusCode: 404, statusMessage: `media ${id} not found` })

  const folder = target.folder ?? row.folder ?? ''
  const filename = target.filename ?? row.filename
  const plan = planObjectRelocation(row, folder, filename)

  // See relocateMedia: same destination-key lock the upload path holds, so a concurrent upload/relocate
  // targeting this exact key can't observe it free mid-way through this copy+insert.
  return withLock(mediaLockKey(plan.storageKey), async () => {
    const clash = db.select({ id: cols.id }).from(media).where(eq(cols.storageKey, plan.storageKey)).get() as { id: number } | undefined
    if (clash) throw createError({ statusCode: 409, statusMessage: `A file already exists at ${plan.storageKey}` })
    await assertDestKeysFree(driver, plan)

    for (const c of plan.copies) await driver.copy(c.src, c.dst)
    try {
      const created = db.insert(media).values({
        storageKey: plan.storageKey, folder: folder || null, filename,
        mime: row.mime, ext: row.ext, size: row.size, width: row.width, height: row.height,
        checksum: row.checksum, thumbhash: row.thumbhash, derivatives: plan.derivatives,
        translations: row.translations ?? {},
      } as never).returning({ id: cols.id }).get() as { id: number }
      emitMediaWrite(null, { id: created.id }) // new media row → re-render listings
      return created
    } catch (error) {
      for (const c of plan.copies) await driver.delete(c.dst)
      throw error
    }
  })
}
