import type { OwnershipManifest } from '@michaelthielemann/kestrel-contracts'

/**
 * The media module's table ownership (ADR-0012): every table `media`'s own code writes/reads directly,
 * for the `<Module>Db` adapter (`makeModuleDb`) to enforce. `media`/`media_settings` are collection
 * tables (built by the schema engine from `defineCollection`); `folders` is media's standalone table,
 * discovered by the schema engine via `#kestrel/schema-tables`, not named by core.
 *
 * @public
 */
export const mediaOwnershipManifest: OwnershipManifest = {
  module: 'media',
  tables: ['media', 'media_settings', 'folders'],
}

// Default export too: `#kestrel/module-manifests` (core's auto-discovery virtual) collects each layer's
// `server/db/manifest.ts` by default export, so the per-module migration task can enumerate manifests
// without core importing this layer directly.
export default mediaOwnershipManifest
