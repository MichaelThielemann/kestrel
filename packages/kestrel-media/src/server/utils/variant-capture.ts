import { eq, getTableColumns } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MediaDb } from '../db/media-db.js'
import { OwnershipViolation } from '@kestrel/core'
import type { ResolvedVariant } from '@kestrel/core'
import { mediaSettings } from '../collections/media-settings.js'
import { reconcileVariants, type StoredVariant } from './variants.js'

// Auto-discovery accumulator. `KestrelImg`/`useMediaVariant` stash their concrete specs on the render's
// `event.context.kestrelVariants`; a `beforeResponse` hook (only for publish/prerender renders, gated on
// `isRendererContext()`/`import.meta.prerender`) drains them into this module Map, keyed by name and
// unioning formats across usages. At the end of a FULL publish / generate `saveDiscoveredVariants`
// reconciles the union into the registry and clears it — so the registry reflects exactly what the last
// full render actually used.
const discovered = new Map<string, ResolvedVariant>()

/** Merge freshly-declared specs into the accumulator (union formats for same-named variants).
 * @public
 */
export function recordVariants(specs: readonly ResolvedVariant[]): void {
  for (const s of specs) {
    if (!s?.name) continue
    const prev = discovered.get(s.name)
    if (prev) prev.formats = [...new Set([...prev.formats, ...(s.formats ?? [])])]
    else discovered.set(s.name, { ...s, formats: [...(s.formats ?? ['webp'])] })
  }
}

/** The accumulator's current contents.
 * @public
 */
export function collectVariants(): ResolvedVariant[] {
  return [...discovered.values()]
}

/** Drops everything accumulated so far.
 * @public
 */
export function clearVariants(): void {
  discovered.clear()
}

/**
 * Reconcile the accumulated discovered specs into the `media_settings` registry (scan entries replaced,
 * manual/pinned kept) and clear the accumulator. Called at the end of a full publish / generate.
 *
 * Safety: if NOTHING was discovered this run, leave the registry untouched rather than wiping every scan
 * entry — a zero result almost always means the capture didn't fire (no KestrelImg rendered, or a plumbing
 * gap), not that the site genuinely uses no variants. Narrowing still works whenever ≥1 variant is found.
 *
 * `{ clear: false }` reconciles WITHOUT draining the accumulator — the classic `nuxt generate` topology has
 * no publisher to run this once at the end, so it reconciles after each prerendered route and the growing
 * accumulator converges to the full used set by the last route.
 * @public
 */
// `public`'s publisher calls this too (an existing, pre-ADR-0012 cross-layer coupling — see media-db.ts's
// TSDoc), auto-imported and so invisible to the static import rail: it hands in
// the raw `useDb()` singleton, not the ownership-checked `MediaDb`. `select`/`insert`/`update`/`transaction`
// are typed identically on both, so the union costs nothing for media's own (checked) call sites.
export function saveDiscoveredVariants(db: MediaDb | BetterSQLite3Database, opts: { clear?: boolean } = {}): void {
  const found = collectVariants()
  if (!found.length) { if (opts.clear !== false) clearVariants(); return }
  const cols = getTableColumns(mediaSettings) as Record<string, never>
  try {
    // The registry is a read-modify-write, and a `nuxt generate` can run against the SAME DB as a live
    // server's publisher — an unguarded select→reconcile→update loses one side's variants. An IMMEDIATE
    // transaction takes SQLite's write lock up front, so a concurrent writer WAITS (busy_timeout) and then
    // reconciles against the already-updated row instead of clobbering it (cross-process safe).
    db.transaction((tx) => {
      const row = tx.select().from(mediaSettings).where(eq(cols.singletonKey, 'media_settings')).get() as
        | { variants?: StoredVariant[] | null }
        | undefined
      // The json field type's column default is the OBJECT shape '{}' (not '[]') — a generic singleton
      // PUT that omits `variants` leaves exactly that, so nullish-only guarding isn't enough here.
      const next = reconcileVariants(Array.isArray(row?.variants) ? row.variants : [], found)
      if (row) tx.update(mediaSettings).set({ variants: next, updatedAt: new Date() } as never).where(eq(cols.singletonKey, 'media_settings')).run()
      else tx.insert(mediaSettings).values({ singletonKey: 'media_settings', variants: next } as never).run()
    }, { behavior: 'immediate' })
    // Drain the accumulator only AFTER a durable write, so a transient failure keeps it for the next pass.
    if (opts.clear !== false) clearVariants()
  } catch (error) {
    // A foreign-table access is a programmer bug (ADR-0012's dev/test guard), not a missing-migration
    // condition — must fail loud, not degrade into "not migrated yet".
    if (error instanceof OwnershipViolation) throw error
    // media_settings not migrated yet — skip persisting the registry (narrowing stays off, config fallback
    // applies) rather than crash the publish. See the schema-drift note; run `drizzle-kit generate`.
    console.warn('[kestrel] media_settings registry not available — variant discovery not persisted:', (error as Error)?.message ?? error)
  }
}
