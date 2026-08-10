import { resolvePage } from '../utils/page-resolve'

// Resolves a public path to the first matching page-like record across ALL pageLike collections (the
// generic render entry point). Published-only EXCEPT for an authenticated admin's live preview:
//   - a static render (build prerender OR the runtime publisher) is always published-only, so a draft
//     never reaches the static site (the renderer principal is itself published-only at the policy
//     level; this explicit `isStaticRender` clause is belt-and-suspenders defense-in-depth);
//   - an anonymous live request carries readScope 'published';
//   - an authenticated admin carries readScope 'all', so a draft renders at its real URL (the preview).
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const path = typeof q.path === 'string' && q.path ? q.path : '/'
  const locale = typeof q.locale === 'string' ? q.locale : undefined
  const isStaticRender = import.meta.prerender === true || isRendererContext()
  const publishedOnly = isStaticRender || event.context.readScope !== 'all'
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
  return { collection: resolved?.collection ?? null, page: resolved?.page ?? null, alternates: resolved?.alternates ?? [], site }
})
