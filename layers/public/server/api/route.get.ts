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
  const resolved = resolvePage(useDb(), allCollections(), path, locale, publishedOnly)
  return { collection: resolved?.collection ?? null, page: resolved?.page ?? null, alternates: resolved?.alternates ?? [] }
})
