/**
 * Auto-import surface for the write pipeline's after-step registration — `pipeline/` and `db/` sit outside
 * Nitro's auto-scanned `server/utils/**` tree, so a consumer (in-repo or via `extends`) that wants to
 * register its own after-step (mirroring `03.redirects.ts`) or its own outbox handler (mirroring
 * `05.reindex-refs.ts` / `05.media-cleanup.ts`) needs these re-exported from here.
 */
export { registerAfterStep, type RegisterAfterStepOptions } from '../pipeline/registry.js'
export { eventsOf, type WriteEvent } from '../pipeline/steps/shared.js'
export { registerOutboxHandler, type OutboxHandler } from '../db/outbox-worker.js'
