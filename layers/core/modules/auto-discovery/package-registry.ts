/**
 * Kestrel's own packages that ship discoverable content, by category — a package declares WHAT it
 * contributes via its own `kestrelDiscovery` named export (see `@kestrel/core`'s `KestrelPackageDiscovery`
 * TSDoc); this module still needs an explicit list of WHICH packages to check, since a Nitro virtual's
 * generated source is plain text written before anything runs — there is no filesystem/`node_modules` scan
 * to discover the list itself. Deliberately per-category, not one flat package list: a virtual only ever
 * imports a package here if that package actually contributes to ITS category, so (for example) building
 * the schema-tables virtual never eagerly touches `@kestrel/collections`, which has none.
 *
 * A package with content in a new category is added to the matching list below when that lands — an
 * explicit, reviewable registration, not a guess. `test/architecture/kestrel-discovery.test.ts`'s
 * "bidirectional consistency" suite computes, against every real workspace package's actual
 * `kestrelDiscovery` export, that these three lists are exactly right (nothing missing, nothing stale) —
 * so a package that starts or stops contributing a category and forgets to update the matching list here
 * fails a fast unit test, not a runtime 404 discovered later.
 */
export const PACKAGE_COLLECTIONS = ['@kestrel/media', '@kestrel/collections', '@kestrel/publishing']
export const PACKAGE_SCHEMA_TABLES = ['@kestrel/media', '@kestrel/publishing']
export const PACKAGE_MANIFESTS = ['@kestrel/media', '@kestrel/publishing']
