import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { OwnershipManifest } from '@kestrel/contracts'
import type { BuiltCollection, CollectionDef } from '@kestrel/core'

/**
 * The shape a Kestrel package exports (as a named `kestrelDiscovery` export from its barrel) so
 * `kestrel-nuxt`'s auto-discovery module can find its collections/schema-tables/manifest WITHOUT
 * filesystem or `node_modules` scanning — the module imports the bare package specifier and reads this
 * object directly, the same way it already reads a consumer layer's `server/collections/*.ts` default
 * exports. Every field is optional: most packages contribute to only one or two categories, and several
 * (`@kestrel/core`, `@kestrel/fields`, `@kestrel/access`, `@kestrel/auth`) contribute to none at all.
 *
 * This is a FIRST-PARTY, internal discovery contract — the packages Kestrel itself ships are the only
 * intended producers, wired together by `kestrel-nuxt`'s own hardcoded `PACKAGE_*` lists (see
 * `layers/core/modules/auto-discovery/package-registry.ts`). A THIRD-PARTY consumer extends Kestrel via
 * the existing layer-directory scan (`server/collections/*.ts` etc.) instead — see
 * `docs/internals/extension-points.md`'s extension section. Marked `@alpha` (not `@public`) to say so structurally:
 * it is exported across the package boundary because `kestrel-nuxt`'s generated virtuals genuinely need to
 * import it from every producing package, but it is not part of the supported external API surface and can
 * change shape without a semver-major bump.
 *
 * No runtime validation is performed anywhere in this contract (not on `KestrelPackageDiscovery`'s shape,
 * not on what `mergeKestrelDiscovered`'s items contain) — deliberately, unlike a boundary contract that
 * validates untrusted input. Every producer is a first-party package built by the SAME `tsc` pass as this
 * file, in the SAME monorepo; a `kestrelDiscovery` value is a live, already-type-checked in-process object
 * (a real `BuiltCollection`, a real drizzle table), never data that crossed a process/network/serialization
 * boundary. TypeScript's own compiler is the validation for this contract; a runtime check here would only
 * duplicate what `tsc` already guarantees for every producer this module will ever see.
 * @alpha
 */
export interface KestrelPackageDiscovery {
  /** Collections this package registers by default (may be built-in-toggled off per consumer). */
  collections?: (CollectionDef | BuiltCollection)[]
  /** Standalone (non-collection) tables this package owns. */
  schemaTables?: AnySQLiteTable[]
  /** This package's ADR-0012 ownership manifest, if it owns any tables. */
  manifest?: OwnershipManifest
}

/**
 * Merge package-provided items with layer/consumer-scanned items into ONE list, keeping exactly one entry
 * per name — last write wins over the WHOLE concatenation (`[...packageItems, ...layerItems]`), not only
 * package-vs-layer: two packages contributing the same name is exactly as much a duplicate-table hazard as
 * a package vs. a layer override, so both collapse the same way. Package-order-stable: for names that
 * never collide, the result keeps `packageItems`' relative order first, then `layerItems`' — a name's FIRST
 * occurrence fixes its position, only its VALUE is replaced by a later same-named entry (`Map.set` on an
 * existing key updates in place, it does not move the key to the end).
 *
 * This is what makes a same-named layer item override a package's (matching `registerCollection`'s own
 * last-registered-wins semantics) — so the schema engine and the runtime registry can never see two
 * same-named collections/tables and silently build a duplicate table. See `KestrelPackageDiscovery`'s own
 * TSDoc for why `items`/`nameOf` are never validated here: first-party, already-type-checked producers.
 * @alpha
 */
export function mergeKestrelDiscovered<T>(packageItems: T[], layerItems: T[], nameOf: (item: T) => string): T[] {
  const byName = new Map<string, T>()
  for (const item of [...packageItems, ...layerItems]) byName.set(nameOf(item), item)
  return [...byName.values()]
}
