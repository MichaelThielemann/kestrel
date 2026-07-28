import { eq, getTableColumns } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { ResolvedVariant, VariantFit } from '../../../core/server/utils/kestrel-config'
import { mediaSettings } from '../collections/media-settings'

const VARIANT_FITS = new Set<VariantFit>(['cover', 'contain', 'inside', 'outside', 'fill'])
// sharp's crop gravity/position values (resize({fit:'cover'|'contain', position})).
const SHARP_POSITIONS = new Set([
  'top', 'right top', 'right', 'right bottom', 'bottom', 'left bottom', 'left', 'left top', 'centre', 'center',
  'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'entropy', 'attention',
])

/**
 * A variant persisted in the `media_settings` registry: a resolved variant plus its provenance. `source`
 * distinguishes an auto-discovered (`'scan'`) entry from a hand-authored (`'manual'`) one; a `manual`/`pinned`
 * entry survives the scan reconcile and wins a name collision with a scanned entry.
 */
export interface StoredVariant extends ResolvedVariant {
  source?: 'manual' | 'scan'
  pinned?: boolean
}

const rank = (v: StoredVariant): number => (v.pinned || v.source === 'manual' ? 1 : 0)

/**
 * The effective variant set to derive: the stored registry entries (deduped by name, a manual/pinned entry
 * winning a scan collision, stripped of provenance and re-defaulted defensively), or `fallback` (the resolved
 * config policy variants) when the registry is empty/absent. `presets` are config-authored named variants
 * (`image.variants`): explicit, name-referenced declarations that are never scan-discovered, so they stay
 * active through usage-driven narrowing (unioned into a non-empty registry, winning any name collision).
 * Pure — the load-bearing logic, unit-tested without a DB.
 */
export function resolveActiveVariants(
  stored: StoredVariant[] | null | undefined, fallback: ResolvedVariant[], presets: ResolvedVariant[] = [],
): ResolvedVariant[] {
  // A registry row is hand-authorable via the media_settings JSON PATCH; reject a name outside the
  // derivative-key charset ([A-Za-z0-9_-]) — an out-of-charset char breaks the URL / the prune-media
  // referencedKeys regex (its derivative is pruned though pages reference it) and a `/` nests a pseudo-folder.
  const safeName = (n: unknown): n is string => typeof n === 'string' && /^[A-Za-z0-9_-]+$/.test(n)
  const list = (Array.isArray(stored) ? stored : []).filter(
    (v): v is StoredVariant => !!v && safeName(v.name) && Number.isFinite(v.width) && v.width >= 1,
  )
  // Empty registry ⇒ the fallback already contains the presets (resolveVariants unions them), so return it as-is.
  if (!list.length) return fallback
  const byName = new Map<string, StoredVariant>()
  for (const v of list) {
    const prev = byName.get(v.name)
    if (!prev || rank(v) > rank(prev)) byName.set(v.name, v)
  }
  for (const p of presets) {
    if (p && typeof p.name === 'string' && p.name !== '' && Number.isFinite(p.width) && p.width >= 1) byName.set(p.name, { ...p, source: 'manual' })
  }
  return [...byName.values()].map((v): ResolvedVariant => ({
    name: v.name,
    width: Math.floor(v.width),
    // coerce a garbage/stale height to null so it never reaches sharp's crop resize and 500s the upload
    height: typeof v.height === 'number' && Number.isFinite(v.height) && v.height >= 1 ? Math.floor(v.height) : null,
    // A hand-authored (media_settings PATCH) fit/position outside sharp's enum would otherwise reach
    // sharp.resize() verbatim and throw for EVERY upload that derives this variant — allow-list, don't
    // just default the nullish case.
    fit: v.fit && VARIANT_FITS.has(v.fit) ? v.fit : 'cover',
    position: typeof v.position === 'string' && SHARP_POSITIONS.has(v.position) ? v.position : 'centre',
    formats: v.formats?.length ? v.formats : ['webp'],
  }))
}

/**
 * Reconcile a fresh scan into the stored registry: every hand-authored entry (`source:'manual'` or
 * `pinned`) is KEPT, and the discovered specs replace ALL prior `source:'scan'` entries (so a variant whose
 * last `KestrelImg` usage was removed disappears — usage-driven narrowing). A manual/pinned entry wins a
 * name collision with a discovered one. Pure — the load-bearing reconcile, unit-tested without a DB.
 */
export function reconcileVariants(existing: StoredVariant[], discovered: ResolvedVariant[]): StoredVariant[] {
  const out: StoredVariant[] = []
  const seen = new Set<string>()
  // Belt-and-braces against the json field type's object-shaped default ('{}', not '[]') reaching here
  // directly — mirrors the Array.isArray guard in resolveActiveVariants.
  for (const e of (Array.isArray(existing) ? existing : [])) {
    if ((e.source === 'manual' || e.pinned) && e.name && !seen.has(e.name)) { out.push(e); seen.add(e.name) }
  }
  for (const d of discovered) {
    if (!d.name || seen.has(d.name)) continue
    out.push({ ...d, source: 'scan' })
    seen.add(d.name)
  }
  return out
}

/**
 * Read the persisted variant registry (the `media_settings` singleton) and resolve the active set,
 * falling back to `fallback` (the resolved config policy variants) when nothing is stored yet. `presets`
 * (config-authored named variants) stay active regardless of the stored set. The upload path calls this
 * so it derives exactly the currently-registered set + presets (narrow generation).
 */
export function activeVariants(db: BetterSQLite3Database, fallback: ResolvedVariant[], presets: ResolvedVariant[] = []): ResolvedVariant[] {
  const cols = getTableColumns(mediaSettings) as Record<string, never>
  let row: { variants?: StoredVariant[] | null } | undefined
  try {
    row = db.select().from(mediaSettings).where(eq(cols.singletonKey, 'media_settings')).get() as
      | { variants?: StoredVariant[] | null }
      | undefined
  } catch {
    // media_settings not migrated yet (a DB provisioned by committed migrations alone) — degrade to the
    // config fallback rather than 500 the upload. Mirrors attachDeadRefs tolerating a missing record_refs.
    row = undefined
  }
  return resolveActiveVariants(row?.variants ?? null, fallback, presets)
}
