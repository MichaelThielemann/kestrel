/**
 * Kestrel's core domain package: the content model types, the field-type and block registries, the
 * schema/table-building pure functions, and the request-scoped read-capture/resolve-scope primitives.
 * Server-only Nuxt/Nitro wiring (pipeline engine, db adapters, schema sync, plugins) stays in
 * `layers/core` until its own extraction lands.
 *
 * @packageDocumentation
 */

// Curated surface. A module is star-exported only while every symbol it exports belongs on the public
// API; otherwise it is exported by NAME. A symbol earns a name here iff a consumer outside the package
// imports it from `@michaelthielemann/kestrel-core` (tests count), or it is intended extension/contract surface, or it
// appears in the signature of another public export. Everything else stays reachable package-internally
// via relative imports but is not public API.

export * from './server/utils/defineCollection.js'
export * from './server/utils/field-layout.js'
export * from './server/utils/populate.js'
export * from './server/utils/seo.js'
export * from './server/utils/collection-types.js'
export * from './server/utils/blocks.js'
export * from './server/registries/field-types.js'
export * from './server/blocks/registry.js'
export * from './server/core/field-rules.js'
export * from './server/core/sanitize.js'
export * from './server/core/workflow.js'
export { resolveColumnName } from './server/utils/naming.js'
export * from './server/utils/block-ids.js'
export * from './server/utils/buildTable.js'
export * from './server/utils/buildFieldSchema.js'
export * from './server/utils/conditional-required.js'
export * from './server/utils/extract-refs.js'
export * from './app/utils/condition.js'
export * from './app/utils/richtext-links.js'
export * from './server/utils/sql.js'
export * from './server/utils/key-lock.js'
export * from './server/utils/read-capture.js'
export * from './server/utils/resolve-scope.js'
export * from './server/utils/kestrel-config.js'
export * from './server/utils/kestrel-config-provider.js'
export * from './server/utils/kestrel-error-map.js'
export { memoDuringPrerender } from './server/utils/prerender-memo.js'

export { createPipelineContext } from './server/pipeline/context.js'
export * from './server/pipeline/define.js'
export * from './server/pipeline/openapi.js'
export { type GateOutcome, type GateEvaluators, runPipeline, runPipelineSync } from './server/pipeline/runner.js'
export { type PipelineTrace, TraceCollector } from './server/pipeline/trace.js'
export { type PipelineContext, type StepDef, syncStep, asyncStep, type AccessSpec, type PipelineDef } from './server/pipeline/types.js'
export { WRITE_OPS, registerDefaultPipelines, isRoutablePipeline, registerPipeline, registerAfterStep, clearPipelines } from './server/pipeline/registry.js'
export { defaultCollectionOps, resolveDefaultPipeline, tryResolveDefaultPipeline, pipelineAccess, runWrite, runRead, runWriteAfterStepsSync } from './server/pipeline/defaults.js'
export * from './server/pipeline/introspect.js'
export * from './server/dashboard/render.js'
export * from './server/pipelines/introspect.js'
export * from './server/pipelines/openapi.js'
export * from './server/pipelines/tooling.js'
export * from './server/pipelines/outbox.js'
export { type ListResult } from './server/pipeline/steps/read-shared.js'
export {
  type WriteEvent, collectionOf, requireRecordId, eventOf, dbOf, eventsOf, isUniqueViolation, fromThrowing,
  fromThrowingAsync,
} from './server/pipeline/steps/shared.js'
export { type BatchResult } from './server/pipeline/steps/persist.js'
export * from './server/schema/dev-sync.js'
export * from './server/schema/dialect.js'
export * from './server/schema/diff.js'
export * from './server/schema/introspect.js'
export * from './server/schema/model.js'
export * from './server/schema/render-sqlite.js'
export * from './server/schema/sync.js'
export { desiredSchema } from './server/schema/desired.js'
export { ensureBuilt, buildCollection } from './server/schema/buildCollection.js'
export * from './server/schema/bootstrap.js'
export * from './server/db/content-db.js'
export * from './server/db/module-order.js'
export {
  type OutboxRow, outboxTableName, ensureOutboxTable, sqliteClientOf, readOutbox, readPendingOutbox, readDeadLetters,
  aggregateKeyOf, nextSequence, buildEnvelope, insertOutboxRow,
} from './server/db/outbox.js'
export * from './server/db/content-manifest.js'
export * from './server/db/outbox-worker.js'
export * from './server/db/revision-migration.js'
export {
  type Row, type RevisionRow, type RevisionUpcastOutcome, type RevisionRetentionPolicy, revisionsTableName,
  revisionsTable, ensureRevisionsTable, insertRevisionRow, readRevisions, rebuildFromRevisions, schemaVersionOf,
  registerRevisionUpcast, clearRevisionUpcasts, applyRevisionUpcast, pruneRevisions, clearPruneCursors,
  pruneAllDueRevisions,
} from './server/db/revisions.js'
export * from './server/db/rollback-metrics.js'
export { OwnershipViolation, type ModuleDbService, type ModuleDbBrand, rawSqliteClientOf, makeModuleDb } from './server/db/module-db.js'
export * from './server/database/record-refs.js'
export * from './server/database/outbox-content.js'
export * from './server/handlers/reindex-refs.js'
export {
  registerCollection, getCollection, requireRegisteredCollection, allCollections, clearRegistry,
} from './server/utils/registry.js'
export * from './server/utils/http.js'
export * from './server/utils/collection-actions.js'
export * from './server/utils/serialize-collection.js'
export * from './server/utils/filter-predicate.js'
export * from './server/utils/page-route.js'
export * from './server/utils/translations.js'
export * from './server/utils/picker.js'
export * from './server/utils/record-ref-index.js'
export {
  type UpdateOptions, type FilterClause, type ListQuery, applyFieldTransforms, parseFilter, list, getOne, create,
  update, remove, removeMany, setStatusMany, getSingleton, putSingleton,
} from './server/utils/crud.js'
export * from './server/utils/after-steps.js'
export * from './server/utils/if-unmodified.js'
export * from './server/utils/pipeline-route.js'
export * from './server/utils/locale.js'
export * from './server/utils/db.js'
export * from './server/utils/revision-retention.js'
export * from './server/utils/storage.js'
export * from './server/utils/storage.local.js'
export * from './server/utils/storage.s3.js'
export * from './server/utils/static-artifacts.js'
export * from './server/utils/data-tags.js'
export * from './server/utils/delivery.js'
export * from './server/utils/kestrel-discovery.js'
export * from './app/utils/filter-ops.js'
export * from './app/utils/list-limits.js'
export * from './app/utils/locale-path.js'
export * from './app/utils/slugify.js'
