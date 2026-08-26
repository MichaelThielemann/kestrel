import type { OwnershipManifest } from '@michaelthielemann/kestrel-contracts'

/**
 * The publishing module's table ownership (ADR-0012): the hand-authored system tables the runtime
 * publisher owns outright — `publish_deps` (the derived route→tag index, `DepsStore`'s durable backing),
 * `publish_status` (the last-outcome-per-route record the editor's live-ampel reads), `publish_runs`
 * (the orchestrator's own command → snapshot → delivery → done state, one row per run), and
 * `published_snapshots` (the immutable per-route publish history a `DeliveryPort` reads from). All four
 * are discovered by the schema engine via `#kestrel/schema-tables`, not named by core. Publishing also READS
 * content collection tables (`allPublishedRoutes`, page-status lookups) — that is a legitimate cross-module
 * read, not ownership, and stays outside this manifest/adapter (mirrors media's `saveDiscoveredVariants`
 * exemption).
 *
 * @public
 */
export const publishingOwnershipManifest: OwnershipManifest = {
  module: 'publishing',
  tables: ['publish_deps', 'publish_status', 'publish_runs', 'published_snapshots'],
}

// Default export too: `#kestrel/module-manifests` (core's auto-discovery virtual) collects each layer's
// `server/db/manifest.ts` by default export, so the per-module migration task can enumerate manifests
// without core importing this layer directly.
export default publishingOwnershipManifest
