import { createPublishQueue } from '../utils/publish/queue'
import { DepsStore } from '../utils/publish/deps'
import { createSqlitePersistence } from '../utils/publish/deps-persistence'
import { outputDriver, publishInvalidation } from '../utils/publish/publisher'
import { classifyWrite, planInvalidation } from '../utils/publish/invalidation'
import { registerWriteListener } from '../../../core/server/utils/write-events'

/**
 * The in-server publish runtime (the production operation model). Wires three things, gated on
 * `output.auto` and skipped in dev (a dev publish would write Vite-dev HTML without hashed `_nuxt`):
 *
 *  1. AUTO-TRIGGER — every content write classifies into an invalidation and enqueues an incremental
 *     republish (a debounced/coalesced/single-flight queue; precise routes via the captured deps index).
 *  2. BOOT PUBLISH — a full publish on startup resyncs this build's `_nuxt` + records every route's deps.
 *     DETACHED (`runNitroPlugins` is synchronous + unawaited; `localFetch` is already wired before plugins
 *     run + before the server listens), so it never blocks boot.
 *  3. RECONCILER — an optional periodic full publish (`output.reconcileMinutes`) self-heals any missed
 *     invalidation and picks up time-based `publishDate` publishing that no write event would trigger.
 */
export default defineNitroPlugin(() => {
  if (import.meta.dev) return
  const output = (useRuntimeConfig().kestrel as { output?: { auto?: boolean; reconcileMinutes?: number; verbose?: boolean } }).output
  if (!output?.auto) return

  // `output.verbose`: on top of the one-line summary, itemise each incremental republish with a
  // timestamped per-route line (rendered / pruned) for traceability. Off by default. (A queued FULL run
  // — boot / reconciler — is a bulk resync and stays a summary; publishInvalidation returns no per-route
  // list for it.)
  const verbose = output.verbose ?? false
  const stamp = () => new Date().toISOString()

  const driver = outputDriver()
  // Durable deps: rehydrate `route → tags` from SQLite so the boot full-publish below can prune routes
  // that were unpublished/deleted while the server was down (staleRoutes over a non-empty tracked set).
  const deps = new DepsStore(createSqlitePersistence(useDb()))
  const queue = createPublishQueue({
    run: async (inv) => {
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

  registerWriteListener(({ def, before, after }) => {
    queue.enqueue(planInvalidation(classifyWrite(def, before, after, primaryLocale(), prefixPrimaryLocale())))
  })

  // Boot publish goes THROUGH the queue (not a direct publishFull) so it shares the single-flight guard:
  // otherwise a boot full-publish could overlap a write-triggered incremental or the reconciler, and both
  // runs share the module-level variant accumulator (corrupting the registry) and can interleave
  // render/prune (leaving an unpublished page live). The queue serializes them.
  queue.enqueue({ type: 'full' })

  const mins = output.reconcileMinutes ?? 0
  if (mins > 0) setInterval(() => queue.enqueue({ type: 'full' }), mins * 60_000).unref?.()
})
