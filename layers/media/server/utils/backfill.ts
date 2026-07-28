import { eq, getTableColumns } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { ResolvedImagePolicy, ResolvedVariant, VariantFormat } from '../../../core/server/utils/kestrel-config'
import type { StorageDriver } from '../../../core/server/utils/storage'
import { media } from '../collections/media'
import { deriveImage, RASTER } from './derive'
import { derivativeKey, type DerivativeManifest } from './record'
import { activeVariants } from './variants'
import { withLock, mediaLockKey } from '../../../core/server/utils/key-lock'
import { emitMediaWrite } from './media-write'

// Mirrors index.post.ts: a long-lived (non-immutable, so a replace isn't pinned) cache for originals +
// derivatives. Backfilled objects MUST carry the same header or the CDN caches them differently.
const MEDIA_CACHE_CONTROL = 'public, max-age=31536000'

export interface BackfillPlan {
  /** Specs, each carrying ONLY its missing formats, to derive + add. */
  missing: ResolvedVariant[]
  /** Object keys of manifest entries no longer in the active set (deregistered) — to prune. */
  orphanKeys: string[]
}

/**
 * Pure diff of a media row's derivative manifest against the active variant set: what to generate, what to
 * prune. A proportional spec wider than the source is never "missing" (deriveImage would skip it, so it can
 * never be satisfied). Orphans are keyed per `<name>.<format>`, so a deregistered FORMAT of a still-active
 * name is pruned too.
 */
export function planBackfill(row: { width: number | null; derivatives: DerivativeManifest | null }, specs: ResolvedVariant[]): BackfillPlan {
  const manifest = row.derivatives ?? {}
  const activeKeys = new Set<string>()
  const missing: ResolvedVariant[] = []
  for (const spec of specs) {
    const applicable = spec.height != null || !row.width || spec.width <= row.width
    const missingFormats: VariantFormat[] = []
    for (const f of spec.formats) {
      activeKeys.add(`${spec.name}.${f}`)
      if (applicable && !(`${spec.name}.${f}` in manifest)) missingFormats.push(f)
    }
    if (missingFormats.length) missing.push({ ...spec, formats: missingFormats })
  }
  const orphanKeys: string[] = []
  for (const [k, entry] of Object.entries(manifest)) if (!activeKeys.has(k) && entry.key) orphanKeys.push(entry.key)
  return { missing, orphanKeys }
}

interface BackfillRow { id: number; storageKey: string; mime: string; width: number | null; derivatives: DerivativeManifest | null }

/**
 * Reconcile ONE media row to the active set: derive its missing variants from the original (put-first),
 * write the updated manifest, then prune orphan objects LAST (a crash never dangles the manifest). The pruned
 * objects are this row's OWN deregistered derivatives — self-owned, so no cross-row ownership guard is needed
 * (that is Slice 9's published-media GC, a different concern).
 */
export async function backfillRow(
  db: BetterSQLite3Database, driver: StorageDriver, row: BackfillRow, specs: ResolvedVariant[], policy: ResolvedImagePolicy,
): Promise<{ generated: number; pruned: number }> {
  const plan = planBackfill(row, specs)
  if (!plan.missing.length && !plan.orphanKeys.length) return { generated: 0, pruned: 0 }

  const orphaned = new Set(plan.orphanKeys)
  const manifest: DerivativeManifest = {}
  for (const [k, e] of Object.entries(row.derivatives ?? {})) if (!orphaned.has(e.key)) manifest[k] = e

  let generated = 0
  if (plan.missing.length) {
    if (typeof driver.get !== 'function') throw new Error('storage driver cannot read originals back (no get()) — backfill needs it')
    const derived = await deriveImage(await driver.get(row.storageKey), { ...policy, variants: plan.missing })
    for (const v of derived.variants) {
      const key = derivativeKey(row.storageKey, v.name, v.format)
      await driver.put(key, v.bytes, v.mime, { cacheControl: MEDIA_CACHE_CONTROL })
      manifest[`${v.name}.${v.format}`] = { key, width: v.width, height: v.height, mime: v.mime }
      generated++
    }
  }

  const cols = getTableColumns(media) as Record<string, never>
  db.update(media).set({ derivatives: manifest, updatedAt: new Date() } as never).where(eq(cols.id, row.id)).run()
  // Published pages hold this row's srcset candidates, so a rewritten manifest — especially a pruned
  // key, which now 404s — has to re-render them. Emitted before the prune: a delete that throws must
  // not leave the already-written manifest un-republished.
  emitMediaWrite({ id: row.id }, { id: row.id })
  for (const key of plan.orphanKeys) await driver.delete(key)
  return { generated, pruned: plan.orphanKeys.length }
}

export interface BackfillReport { rows: number; rowsChanged: number; generated: number; pruned: number; check: boolean }

/**
 * Iterate every raster media row, reconciling each to the active variant set. Sequential (sharp CPU + a
 * full-original GET per row) and best-effort per row — a corrupt original is logged and skipped, never
 * aborting the whole run. `check` reports the plan (rows / would-generate / would-prune) without writing.
 */
export async function runBackfill(
  db: BetterSQLite3Database, driver: StorageDriver, policy: ResolvedImagePolicy, opts: { check?: boolean } = {},
): Promise<BackfillReport> {
  const specs = activeVariants(db, policy.variants, policy.presets)
  const rows = db.select().from(media).all() as BackfillRow[]
  const report: BackfillReport = { rows: rows.length, rowsChanged: 0, generated: 0, pruned: 0, check: !!opts.check }
  for (const snapshot of rows) {
    if (!RASTER.has(snapshot.mime)) continue
    if (opts.check) {
      // Dry-run reads only (against the snapshot) — no mutation, so no lock.
      const plan = planBackfill(snapshot, specs)
      const toGenerate = plan.missing.reduce((n, s) => n + s.formats.length, 0)
      if (!toGenerate && !plan.orphanKeys.length) continue
      report.rowsChanged++
      report.generated += toGenerate
      report.pruned += plan.orphanKeys.length
      continue
    }
    // Serialize per storageKey with the upload path, and re-read the row FRESH inside the lock: a concurrent
    // overwrite may have replaced the bytes/dims/manifest since the up-front snapshot, and reconciling the
    // stale snapshot against the new object would write a manifest whose dims describe the OLD image.
    await withLock(mediaLockKey(snapshot.storageKey), async () => {
      const cols = getTableColumns(media) as Record<string, never>
      const row = db.select().from(media).where(eq(cols.id, snapshot.id)).get() as BackfillRow | undefined
      if (!row || !RASTER.has(row.mime)) return
      const plan = planBackfill(row, specs)
      if (!plan.missing.length && !plan.orphanKeys.length) return
      report.rowsChanged++
      try {
        const r = await backfillRow(db, driver, row, specs, policy)
        report.generated += r.generated
        report.pruned += r.pruned
      } catch (error) {
        console.error(`[kestrel] backfill failed for media ${row.id} (${row.storageKey}):`, (error as Error)?.message ?? error)
      }
    })
  }
  return report
}
