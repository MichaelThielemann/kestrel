// Registers the built-in field types (module-load side effect in `@michaelthielemann/kestrel-fields` itself). Must run
// before this barrel's own `buildCollection()` calls (site.js, redirects.js) evaluate — an ESM barrel is
// an eager, whole-module-graph load (ADR-0029), so ANY consumer importing anything at all from this
// package — even an early boot-phase plugin that only wants `ensureSnapshotTriggers` — would otherwise
// reach those collection definitions before the registry has "text" et al. Placed first so file order (not
// what the consumer actually imports) is what guarantees the ordering.
//
// Imported as a USED BINDING, not a bare side-effect import (`import '@michaelthielemann/kestrel-fields'`) — this package
// declares `"sideEffects": false` in package.json, so a bare import is exactly what would let a compliant
// bundler prove the registration call unneeded and tree-shake it away (fields' own `sideEffects` array
// names only its `field-registry` entry point, not the bare barrel this resolves to). Referencing the
// binding defeats that (mirrors `test/setup.ts`'s own `fieldTypes` idiom, one file over).
import { fieldTypes } from '@michaelthielemann/kestrel-fields'
import type { KestrelPackageDiscovery } from '@michaelthielemann/kestrel-core'
import { publishingOwnershipManifest as manifest } from './server/db/manifest.js'
import { publishedSnapshots } from './server/db/snapshots.js'
import { publishDeps } from './server/database/publish-deps.js'
import { publishRuns } from './server/database/publish-runs.js'
import { publishStatus } from './server/database/publish-status.js'
import siteCollectionDefault from './server/collections/site.js'
import redirectsCollectionDefault from './server/collections/redirects.js'

void fieldTypes

/** `kestrel-nuxt`'s auto-discovery reads this — see `@michaelthielemann/kestrel-core`'s `KestrelPackageDiscovery` TSDoc.
 * First-party discovery contract — consumers extend Kestrel via layer directories, see
 * `docs/guide/publishing.md`.
 * @alpha
 */
export const kestrelDiscovery: KestrelPackageDiscovery = {
  collections: [siteCollectionDefault, redirectsCollectionDefault],
  schemaTables: [publishedSnapshots, publishDeps, publishRuns, publishStatus],
  manifest,
}

export { publishingOwnershipManifest } from './server/db/manifest.js'
export {
  type PublishingDb,
  usePublishingDbFor,
  usePublishingDb,
} from './server/db/publishing-db.js'
export {
  publishedSnapshots,
  TRIGGER_DDL,
  ensureSnapshotTriggers,
  type SnapshotRow,
  type SnapshotPayload,
  type SnapshotsDb,
  recordSnapshot,
  republishSnapshot,
  currentSnapshot,
  currentRoutes,
  retractSnapshot,
} from './server/db/snapshots.js'
export { publishDeps } from './server/database/publish-deps.js'
export { publishRuns, PUBLISH_RUNS_RETENTION } from './server/database/publish-runs.js'
export { publishStatus } from './server/database/publish-status.js'

// The render-live seam: `setRenderRouteLive` is called explicitly by each real entry point (`zz.publish.ts`'s
// plugin body, `tasks/publish/run.ts`'s task body) right before the call that needs it — see
// `render-seam.ts`'s own TSDoc for why NOT a module-load side effect. `renderRouteLive` and
// `clearRenderRouteLive` are re-exported too: package tests wire/reset the seam directly (they have no
// layer to import from), mirroring the config-provider seam's own set/get/clear shape.
export { setRenderRouteLive, renderRouteLive, clearRenderRouteLive, type RenderRouteLive } from './server/utils/publish/render-seam.js'

export { htmlKeyForRoute } from './server/utils/publish/route-keys.js'
export { routeForRecord } from './server/utils/publish/route-for-record.js'
export {
  routesForTags,
  staleRoutes,
  type DepsPersistence,
  DepsStore,
} from './server/utils/publish/deps.js'
export { createSqlitePersistence, type DepsPersistenceDb } from './server/utils/publish/deps-persistence.js'
export {
  recordPublishStatus,
  clearPublishStatus,
  renderOutcome,
  lastPublishedAt,
  type PublishOutcome,
  type PublishStatusDb,
} from './server/utils/publish/publish-status.js'
export {
  translationGroupTag,
  pagePathTag,
  routesToPrune,
  planWrite,
  planSaveInvalidation,
  planInvalidation,
  classifyWrite,
  type Invalidation,
  type WriteCollection,
  type WriteClassification,
  type Row,
} from './server/utils/publish/invalidation.js'
export { coalesce } from './server/utils/publish/coalesce.js'
export {
  createPublishQueue,
  type PublishQueue,
  type PublishQueueOptions,
} from './server/utils/publish/queue.js'
export {
  hasPendingChanges,
  pendingRoutes,
  heldRoutes,
  type HeldRoutes,
} from './server/utils/publish/pending.js'
export {
  setPublishRuntime,
  usePublishRuntime,
  type PublishRuntime,
} from './server/utils/publish/publish-runtime.js'
export {
  outputConfig,
  outputDriver,
  allPublishedRoutes,
  publishRoutes,
  prunePages,
  publishFull,
  publishInvalidation,
  type PublishMode,
  type PublishedRoutes,
  type PublishResult,
  type OutputRc,
} from './server/utils/publish/publisher.js'
export {
  startPublishRun,
  resumePublishRuns,
  type PublishRunRecord,
  type PublishDelivery,
  type OrchestratorDb,
} from './server/utils/publish/orchestrator.js'

export { buildPublishPipelines } from './server/pipelines/publish.js'
export { buildPublishRunsPipelines } from './server/pipelines/publish-runs.js'

export { registerPlanPublish } from './server/handlers/plan-publish.js'

export { site, default as siteCollection } from './server/collections/site.js'
export { redirects, default as redirectsCollection } from './server/collections/redirects.js'

export {
  type LlmsEntry,
  type LlmsSection,
  collectionHeading,
  buildLlmsTxt,
} from './server/utils/content/llms.js'
export {
  type LlmsFullPage,
  type LlmsFullSection,
  LLMS_FULL_HEADING_OFFSET,
  buildLlmsFullTxt,
  type RecordMarkdownOptions,
  recordMarkdown,
} from './server/utils/content/llms-full.js'
export {
  type SitemapAlternate,
  type SitemapEntry,
  type SitemapCandidate,
  normalizeBase,
  withHreflang,
  buildSitemap,
  buildRobots,
} from './server/utils/content/sitemap.js'
export { isPubliclyLinkable, resolveInternalHref } from './server/utils/content/link-resolve.js'
export {
  type PageAlternate,
  type PageAncestor,
  type ResolvedPage,
  type PageResolution,
  resolvePage,
} from './server/utils/content/page-resolve.js'
export { type ResolveHref, buildLinkFieldPopulators } from './server/utils/content/populate-links.js'
export { siteBaseUrl, siteName, siteDescription, llmsFullEnabled } from './server/utils/content/site-url.js'

export {
  type RedirectRule,
  REDIRECT_STATUSES,
  RedirectRuleError,
  patternToRegexSource,
  normalizeTarget,
  compileRedirects,
  compilePublishableRedirects,
  serializeRedirects,
  matchRedirect,
} from './server/utils/publish/redirect-rules.js'
export {
  REDIRECTS_COLLECTION,
  REDIRECTS_FIELD,
  REDIRECTS_KEY,
  writeRedirectsArtifact,
} from './server/utils/publish/redirects-artifact.js'

export { buildRoutePipelines } from './server/pipelines/route.js'
export { buildPreviewPipelines } from './server/pipelines/preview.js'
export { buildLinkPipelines } from './server/pipelines/links.js'
