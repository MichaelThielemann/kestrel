import { publishFull, outputDriver } from '../../utils/publish/publisher'
import { DepsStore } from '../../utils/publish/deps'
import { createSqlitePersistence } from '../../utils/publish/deps-persistence'

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
    // The same durable store the boot-publish plugin uses, so a manually-triggered run also prunes
    // routes that left the published set and records deps for later incremental publishes.
    const deps = new DepsStore(createSqlitePersistence(useDb()))
    const result = await publishFull(outputDriver(), deps)
    console.info(`[kestrel] publish:run rendered ${result.rendered} route(s), pruned ${result.pruned}`)
    return { result }
  },
})
