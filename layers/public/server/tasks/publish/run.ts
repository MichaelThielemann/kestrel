import { renderRouteLive } from '../../utils/publish/render-live'
import { publishFull, outputDriver, DepsStore, createSqlitePersistence, usePublishingDb, setRenderRouteLive } from '@michaelthielemann/kestrel-publishing'

/**
 * The shared publish engine, exposed as a Nitro task. Renders every published page (+ sitemap/robots)
 * via the live server, mirrors `_nuxt`/assets, and always prunes the routes that left the published set
 * (output ≡ DB). Like every full publish it HOLDS BACK routes with unpublished changes (ADR-0008) — a
 * resync must not push work in progress live; those pages go out when they are published.
 *
 * Triggering (Nuxt 4.4 / Nitro 2.13 — there is NO `nuxi task run`):
 *   - dev:  GET http://localhost:3000/_nitro/tasks/publish:run   (the dev-only task route; plumbing smoke test)
 *   - prod: the boot-publish plugin (`zz.publish.ts`) runs this on startup; for an on-demand prod trigger,
 *           expose your own authenticated route that calls `runTask('publish:run')` (the built node-server
 *           has no task endpoint/CLI — only `runTask()` from inside the process + cron `scheduledTasks`).
 */
export default defineTask({
  meta: { name: 'publish:run', description: 'Render all published pages to the configured static output (HTML + _nuxt + assets)' },
  async run() {
    // Wired explicitly here (not a module-load side effect): Nitro dev re-evaluates a task's module graph
    // per invocation for hot-reload, which can give this call and `publisher.ts`'s a differently-scoped
    // `@michaelthielemann/kestrel-publishing` instance if the wiring only ran once, earlier, at a boot-time import — calling
    // the setter fresh, synchronously, right before the only call that needs it removes that dependency on
    // import-order/instance-identity entirely. Idempotent: safe to call before every run.
    setRenderRouteLive(renderRouteLive)
    // The same durable store the boot-publish plugin uses, so a manually-triggered run also prunes
    // routes that left the published set and records deps for later incremental publishes.
    const deps = new DepsStore(createSqlitePersistence(usePublishingDb().db))
    const result = await publishFull(outputDriver(), deps)
    console.info(`[kestrel] publish:run rendered ${result.rendered} route(s), pruned ${result.pruned}`)
    return { result }
  },
})
