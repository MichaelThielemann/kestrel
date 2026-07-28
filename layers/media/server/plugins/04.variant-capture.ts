import { recordVariants, saveDiscoveredVariants } from '../utils/variant-capture'

/**
 * Auto-discovery capture. `KestrelImg`/`useMediaVariant` stash their concrete specs on the render's
 * `event.context.kestrelVariants` during SSR. Renders count when they are either a PUBLISH render (the
 * incremental publisher marks them with the `x-kestrel-publish` header, see publisher.ts `renderRoute`) OR
 * a build-time PRERENDER render (the classic `nuxt generate` topology) — so live preview / stray runtime
 * renders never pollute the scan. For a publish, `publishFull` reconciles the drained accumulator once at
 * the end; the generate topology has no such orchestrator, so each prerendered route reconciles inline
 * WITHOUT draining and the growing accumulator converges to the full used set by the last route.
 *
 * NOTE: relies on `beforeResponse` firing for the publisher's `localFetch` renders / the prerenderer, and on
 * the app→server `event.context` bridge — verified by a real publish/generate, not the headless unit suite.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event) => {
    const isPrerender = import.meta.prerender === true
    if (getRequestHeader(event, 'x-kestrel-publish') !== '1' && !isPrerender) return
    const specs = (event.context as { kestrelVariants?: unknown[] }).kestrelVariants
    if (Array.isArray(specs) && specs.length) recordVariants(specs as never)
    if (isPrerender) saveDiscoveredVariants(useDb(), { clear: false })
  })
})
