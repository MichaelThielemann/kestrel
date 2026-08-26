import { renderRouteLive } from '../utils/publish/render-live'
import {
  createPublishQueue,
  setPublishRuntime,
  DepsStore,
  createSqlitePersistence,
  usePublishingDb,
  outputDriver,
  publishInvalidation,
  resumePublishRuns,
  startPublishRun,
  setRenderRouteLive,
  type PublishDelivery,
} from '@michaelthielemann/kestrel-publishing'

/**
 * The in-server publish runtime (the production operation model). Wires the queue + deps index and gates
 * whether they exist at all, on `output.auto`, skipped in dev (a dev publish would write Vite-dev HTML
 * without hashed `_nuxt`):
 *
 *  1. THE RUNTIME ITSELF — `setPublishRuntime` publishes the queue + deps index via `usePublishRuntime()`.
 *     The `planPublish` outbox handler (`handlers/plan-publish.ts`, registered independently by
 *     `05.plan-publish.ts`) is the actual AUTO-TRIGGER: it classifies every content/media write into an
 *     invalidation and enqueues it, but only when this plugin has actually set a runtime — a no-op
 *     otherwise (dev, or `output.auto` off), so the gate lives here even though the trigger does not.
 *  2. BOOT PUBLISH — a full publish on startup resyncs this build's `_nuxt` + records every route's deps.
 *     DETACHED (`runNitroPlugins` is synchronous + unawaited; `localFetch` is already wired before plugins
 *     run + before the server listens), so it never blocks boot. A FULL run (boot's own, and the
 *     reconciler's below) goes through `startPublishRun`, so its command -> snapshot -> delivery ->
 *     done sequence is persisted to `publish_runs` and survives a crash — an incremental (tag) run a
 *     content/media write triggers stays a direct `publishInvalidation` call, since it is not part of
 *     the owned sequence.
 *  3. RECONCILER — an optional periodic full publish (`output.reconcileMinutes`) self-heals any missed
 *     invalidation, also tracked as an owned run. The self-heal is real, not just "re-render everything
 *     and hope": every full/reconcile publish live-renders each published route and compares its
 *     fingerprint against the currently recorded snapshot (`publisher.ts`'s `PublishMode: 'reconcile'`,
 *     ADR-0013's amendment) — a mismatch (a missed invalidation, a template/component deploy) records +
 *     delivers the fresh render; a match costs nothing beyond the render itself.
 *
 * Crash-resume (ADR-0025): `resumePublishRuns` marks any run a crash left `running` as `failed` — it does
 * NOT redeliver — and runs BEFORE the boot enqueue below, which fires unconditionally regardless of what
 * resume found. The queue remains the ONLY caller that ever invokes a delivery; resume never bypasses its
 * single-flight guard.
 */
export default defineNitroPlugin(() => {
  if (import.meta.dev) return
  const output = (useRuntimeConfig().kestrel as { output?: { auto?: boolean; publishOnSave?: boolean; reconcileMinutes?: number; verbose?: boolean } }).output
  if (!output?.auto) return

  // Wired explicitly here (not a module-load side effect) — see tasks/publish/run.ts's own comment for
  // why: it removes any dependency on import-order/instance-identity between this plugin's own
  // `@michaelthielemann/kestrel-publishing` import and the one `publisher.ts`'s internals resolve. Idempotent.
  setRenderRouteLive(renderRouteLive)

  // `output.verbose`: on top of the one-line summary, itemise each incremental republish with a
  // timestamped per-route line (rendered / pruned) for traceability. Off by default. (A queued FULL run
  // — boot / reconciler — is a bulk resync and stays a summary; publishInvalidation returns no per-route
  // list for it.)
  const verbose = output.verbose ?? false
  const stamp = () => new Date().toISOString()

  const driver = outputDriver()
  // Durable deps: rehydrate `route → tags` from SQLite so the boot full-publish below can prune routes
  // that were unpublished/deleted while the server was down (staleRoutes over a non-empty tracked set).
  const deps = new DepsStore(createSqlitePersistence(usePublishingDb().db))

  // The delivery port for a FULL run: the real renderer, driven the same way a queued full invalidation
  // always was. `startPublishRun` persists the command -> snapshot -> delivery -> done sequence around
  // this call; this closure is only the "delivery" step itself.
  const fullDelivery: PublishDelivery = {
    deliver: async () => {
      const { rendered, pruned, counts } = await publishInvalidation({ type: 'full' }, driver, deps)
      if (counts.rendered === 0 && counts.pruned === 0) return
      console.info(`[kestrel] published ${counts.rendered} route(s) (pruned ${counts.pruned})`)
      if (verbose) {
        for (const route of rendered) console.info(`[kestrel] ${stamp()} rendered ${route}`)
        for (const route of pruned) console.info(`[kestrel] ${stamp()} pruned ${route}`)
      }
    },
  }

  const queue = createPublishQueue({
    run: async (inv) => {
      if (inv.type === 'full') {
        const result = await startPublishRun(fullDelivery)
        // Rethrow on a recorded failure so the queue's own retry-on-failure fires (its `.catch()` calls
        // `onError` below and re-queues the batch) — `startPublishRun` itself never throws for a delivery
        // failure (it resolves with the outcome as data), so restoring that retry has to happen here.
        // `id: 0` is the synthetic placeholder `startPublishRun`'s missing-table fallback returns (no real
        // row backs it) — label it distinctly rather than a misleading "#0".
        if (result.status === 'failed') throw new Error(`publish run #${result.id === 0 ? 'untracked' : result.id} failed: ${result.error}`)
        return
      }
      const { rendered, pruned, counts } = await publishInvalidation(inv, driver, deps)
      if (counts.rendered === 0 && counts.pruned === 0) return
      // Incremental runs name the routes; a queued full run (the reconciler) prints counts only.
      const list = rendered.length ? `: ${rendered.join(', ')}` : ''
      console.info(`[kestrel] published ${counts.rendered} route(s)${list} (pruned ${counts.pruned})`)
      if (verbose) {
        for (const route of rendered) console.info(`[kestrel] ${stamp()} rendered ${route}`)
        for (const route of pruned) console.info(`[kestrel] ${stamp()} pruned ${route}`)
      }
    },
    onError: (error) => console.error('[kestrel] publish run failed:', error),
  })

  // The explicit publish action (`POST /api/publish`) enqueues through this same queue, so a publish and
  // a write-driven prune are serialized by one single-flight run rather than racing each other.
  setPublishRuntime({ queue, deps })

  // Boot publish goes THROUGH the queue (not a direct publishFull) so it shares the single-flight guard:
  // otherwise a boot full-publish could overlap a write-triggered incremental or the reconciler, and both
  // runs share the module-level variant accumulator (corrupting the registry) and can interleave
  // render/prune (leaving an unpublished page live). The queue serializes them, and it is the ONLY
  // AUTOMATIC caller that ever invokes a delivery — `resumePublishRuns` below just updates rows, so there
  // is nothing left to race it. (The `publish:run` Nitro task — `tasks/publish/run.ts` — is a documented
  // exception: an operator-triggered manual run that calls `publishFull` directly, outside this queue.)
  //
  // Resume runs first, awaited: it is a plain DB update (never invokes delivery, so it cannot itself
  // crash the process the way a redelivered render could), which is what guarantees the boot enqueue below
  // always fires — a resume that instead redelivered and crashed again the same way would leave the row
  // `running` forever and never reach this line, an infinite boot loop that never makes progress.
  void resumePublishRuns().finally(() => queue.enqueue({ type: 'full' }))

  const mins = output.reconcileMinutes ?? 0
  if (mins > 0) setInterval(() => queue.enqueue({ type: 'full' }), mins * 60_000).unref?.()
})
