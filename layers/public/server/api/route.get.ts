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
  const resolved = resolvePage(db, allCollections(), path, locale, publishedOnly)
  // The site-wide head tier rides along on the fetch the page already awaits, so it reaches SSR and the
  // prerender on a path that is known to work. Looked up through the registry, not imported, so a consumer
  // that disables the collection gets `null` instead of a query against a table the schema never created.
  // `depth: 1` resolves the sharing image into `$media`; `getSingleton` captures the read, so an edit
  // re-publishes every route that embedded it.
  const siteCollection = getCollection('site')
  const site = siteCollection ? getSingleton(db, siteCollection, locale, false, 1) : null
  return { collection: resolved?.collection ?? null, page: resolved?.page ?? null, alternates: resolved?.alternates ?? [], site }
})
