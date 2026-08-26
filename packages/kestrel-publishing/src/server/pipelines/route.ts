import { createError } from 'h3'
import { Effect } from 'effect'
import { isRendererContext } from '@michaelthielemann/kestrel-access'
import { allCollections, definePipeline, getCollection, getSingleton, isDeliveryExemptPath, isDeliveryLive, syncStep, useDb } from '@michaelthielemann/kestrel-core'
import type { PipelineDef, StepDef } from '@michaelthielemann/kestrel-core'
import { resolvePage } from '../utils/content/page-resolve.js'

/** Substitutes for Nitro's `import.meta.prerender` (a build-time-replaced constant, unavailable to a
 *  package's own isolated `ImportMeta` type — same class of gap as `publish.ts`'s `isDevMode()`). Still
 *  reads the real runtime value Nitro injects; only the TYPE is unavailable here, not the value. */
function isPrerenderMode(): boolean {
  return (import.meta as unknown as { prerender?: boolean }).prerender === true
}

// Resolves a public path to the first matching page-like record across ALL pageLike collections (the
// generic render entry point). Published-only EXCEPT for an authenticated admin's live preview:
//   - a static render (build prerender OR the runtime publisher) is always published-only, so a draft
//     never reaches the static site (the renderer principal is itself published-only at the policy
//     level; this explicit `isStaticRender` clause is belt-and-suspenders defense-in-depth);
//   - an anonymous live request carries readScope 'published';
//   - an authenticated admin carries readScope 'all', so a draft renders at its real URL (the preview).
//
// `resolvePage` and `getSingleton` are the CRUD facade's programmatic reads: they run under the trusted
// gates as the system principal at scope 'all', which is the documented deliberate exception that gives
// the renderer and anonymous visitors the FULL populate for this route (see docs/internals/publishing.md). The
// published-only decision above is what bounds them, not the request's own gates.
const resolveRoute: StepDef = syncStep('resolveRoute', (ctx) => Effect.sync(() => {
    const input = (ctx.input ?? {}) as Record<string, unknown>
    const path = typeof input.path === 'string' && input.path ? input.path : '/'
    const locale = typeof input.locale === 'string' ? input.locale : undefined
    const isStaticRender = isPrerenderMode() || isRendererContext()
    const publishedOnly = isStaticRender || ctx.facts.readScope !== 'all'
    // A `deliveryExempt` path reserves that URL for the consumer's own runtime route under `delivery:
    // 'live'` (see `@michaelthielemann/kestrel-core`'s `delivery.ts`) — public/static resolution must not fill it in with a
    // page-like record either, or a page saved at the same path would still shadow that route the same
    // way the live catch-all is built to avoid. Scoped to `publishedOnly`: an authenticated admin's own
    // preview of a record saved at that path is unaffected.
    if (publishedOnly && isDeliveryLive() && isDeliveryExemptPath(path)) {
      throw createError({ statusCode: 404, statusMessage: 'Page not found' })
    }
    const db = useDb()
    const { page: resolved, failed } = resolvePage(db, allCollections(), path, locale, publishedOnly)
    // The site-wide head tier rides along on the fetch the page already awaits, so it reaches SSR and the
    // prerender on a path that is known to work. Looked up through the registry, not imported, so an
    // installation whose registry never received the built-in simply has the tier off (`null`) instead of
    // querying a table the schema never created. `depth: 1` resolves the sharing image into `$media`;
    // `getSingleton` captures the read, so an edit re-publishes every route that embedded it.
    const siteCollection = getCollection('site')
    let site: ReturnType<typeof getSingleton> = null
    let siteUnreadable = false
    if (siteCollection) {
      try { site = getSingleton(db, siteCollection, locale, false, 1) }
      catch (error) {
        // Registered but unreadable (its migration hasn't been run) — indistinguishable in the response from
        // the off state above, so it joins the incomplete-read channel rather than degrading silently.
        siteUnreadable = true
        console.error('[kestrel] route: the site singleton could not be read:', (error as Error)?.message ?? error)
      }
    }
    // One rule for every incomplete read: never answer 200. The publisher classifies a 200-with-body as a
    // successful render, writes it over the live file and records success — so an unreadable page collection
    // would bake the catch-all's empty document over a real page (the record may well live in the collection
    // that failed, which is why this is not a 404), and an unreadable head tier would strip the composed
    // title, default description and sharing image from every route it touches. Both are unrecoverable
    // without a full re-publish and neither leaves a mark. A 5xx keeps the existing artifact and turns the
    // editor's status red. The head tier is site-wide, so it fails the request even when a page did resolve.
    if (siteUnreadable || (failed.length && !resolved)) {
      throw createError({ statusCode: 503, statusMessage: 'Route lookup incomplete' })
    }
    ctx.output = {
      collection: resolved?.collection ?? null,
      page: resolved?.page ?? null,
      alternates: resolved?.alternates ?? [],
      // The breadcrumb trail rides the same fetch as the hreflang set, for the same reason: it is resolved
      // from the DB, and the publish-dep capture only works on a path the renderer actually awaits.
      ancestors: resolved?.ancestors ?? [],
      site,
    }
}))

/** Readable by everyone — it is the runtime equivalent of serving a static page — but the read SCOPE
 *  follows the principal, which is what makes the same URL serve a draft to an admin and only published
 *  content to everyone else. */
/** @public */
export function buildRoutePipelines(): PipelineDef[] {
  return [definePipeline({ name: 'route', read: true, access: { public: true, scope: 'published' }, steps: [resolveRoute] })]
}
