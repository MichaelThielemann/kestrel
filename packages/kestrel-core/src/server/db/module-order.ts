import type { OwnershipManifest } from '@michaelthielemann/kestrel-contracts'

/**
 * Canonical per-module migration order (ADR-0012 domains). `content` is the collection/base schema
 * (built-ins + `record_refs`) every other module is conceptually layered on, so it always runs first;
 * the rest follow this fixed order. Deliberately NOT derived from Nuxt's layer discovery order — that
 * order differs between an in-repo dev scan (reverse-alphabetical local `layers/` auto-scan) and a
 * packaged consumer's `extends` array (see `nuxt.config.ts`), so it is never a safe migration-order
 * signal. A module not listed here (a future extension) keeps its discovery order, appended after every
 * listed one.
 * @public
 */
export const MODULE_MIGRATION_ORDER = ['content', 'media', 'publishing'] as const

/** Sort `manifests` into `MODULE_MIGRATION_ORDER`; anything unlisted keeps its relative input order,
 * @public
 *  appended after every listed module. */
export function orderManifests(manifests: readonly OwnershipManifest[]): OwnershipManifest[] {
  const rank = new Map<string, number>(MODULE_MIGRATION_ORDER.map((m, i) => [m, i]))
  return manifests
    .map((manifest, index) => ({ manifest, index, rank: rank.get(manifest.module) ?? MODULE_MIGRATION_ORDER.length }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.manifest)
}
