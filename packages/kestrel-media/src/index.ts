// Registers the built-in field types (module-load side effect in `@kestrel/fields` itself). Must run
// before this barrel's own `buildCollection()` calls (media.js, media-settings.js) evaluate — an ESM
// barrel is an eager, whole-module-graph load (ADR-0029), so ANY consumer importing anything at all from
// this package — including a direct import that bypasses `kestrel-nuxt`'s own `#kestrel/collections`
// virtual guard entirely, e.g. a plugin reaching straight into `@kestrel/media` for its own reasons — would
// otherwise reach those collection definitions before the registry has "text" et al. Placed first so file
// order (not what the consumer actually imports) is what guarantees the ordering.
//
// Imported as a USED BINDING, not a bare side-effect import (`import '@kestrel/fields'`) — this package
// declares `"sideEffects": false` in package.json, so a bare import is exactly what would let a compliant
// bundler prove the registration call unneeded and tree-shake it away. Mirrors `@kestrel/publishing`'s own
// barrel (see its TSDoc for the full reasoning) and `test/setup.ts`'s own `fieldTypes` idiom.
import { fieldTypes } from '@kestrel/fields'
import type { KestrelPackageDiscovery } from '@kestrel/core'
import mediaCollectionDefault from './server/collections/media.js'
import mediaSettingsCollectionDefault from './server/collections/media-settings.js'
import { folders as foldersTable } from './server/database/folders.js'
import { mediaOwnershipManifest as manifest } from './server/db/manifest.js'

void fieldTypes

export { media, default as mediaCollection } from './server/collections/media.js'
export { mediaSettings, default as mediaSettingsCollection } from './server/collections/media-settings.js'
export { folders } from './server/database/folders.js'
export { mediaOwnershipManifest } from './server/db/manifest.js'

/** `kestrel-nuxt`'s auto-discovery reads this — see `@kestrel/core`'s `KestrelPackageDiscovery` TSDoc.
 * First-party discovery contract — consumers extend Kestrel via layer directories, see
 * `docs/guide/media.md`.
 * @alpha
 */
export const kestrelDiscovery: KestrelPackageDiscovery = {
  collections: [mediaCollectionDefault, mediaSettingsCollectionDefault],
  schemaTables: [foldersTable],
  manifest,
}
export {
  type MediaDb,
  useMediaDbFor,
  useMediaDb,
  sqliteClientOfMediaDb,
} from './server/db/media-db.js'
export { registerMediaCleanup } from './server/handlers/media-cleanup.js'
export { buildMediaPipelines } from './server/pipelines/index.js'
export {
  mediaCollectionEnabled,
  requireMediaCollection,
} from './server/utils/media-enabled.js'
export {
  type ResolveById,
  buildMediaFieldPopulator,
} from './server/utils/populate.js'
export {
  type MediaVariant,
  type AiSourceType,
  type ResolvedMedia,
  resolveMedia,
  orderById,
  resolveManyByIds,
} from './server/utils/resolve.js'
export {
  type OpItem,
  type AffectedMedia,
  type AffectedSet,
  collectAffected,
  bulkUsages,
  type DeleteReport,
  previewDelete,
  deleteAffected,
} from './server/utils/media-ops.js'
export {
  type RelocatePlan,
  planObjectRelocation,
  relocateMedia,
  duplicateMedia,
} from './server/utils/storage-relocate.js'
export {
  type OpType,
  type MediaOp,
  type Conflict,
  type RelocationReport,
  coerceOpItems,
  planItem,
  validateOp,
  previewRelocation,
  type OpResult,
  executeRelocation,
  runRelocation,
} from './server/utils/relocate-ops.js'
export { ensureFolder } from './server/utils/folders.js'
export {
  type LibraryQuery,
  type LibraryFolder,
  listLibrary,
} from './server/utils/library.js'
export {
  type MediaUsage,
  findMediaUsagesForMany,
  findMediaUsages,
} from './server/utils/usages.js'
export {
  type BackfillPlan,
  planBackfill,
  backfillRow,
  type BackfillReport,
  runBackfill,
} from './server/utils/backfill.js'
export {
  recordVariants,
  collectVariants,
  clearVariants,
  saveDiscoveredVariants,
} from './server/utils/variant-capture.js'
export {
  variantKeyFromPath,
  parseVariantName,
  type VariantRequest,
  resolveVariantRequest,
  deriveOnDemand,
} from './server/utils/ondemand.js'
export {
  type MediaRuntimeConfig,
  mediaRuntimeConfig,
  useStorageDriver,
} from './server/utils/storage.js'
