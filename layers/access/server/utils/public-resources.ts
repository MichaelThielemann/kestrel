import { allCollections } from '../../../core/server/utils/registry'

/**
 * Collections an anonymous visitor may read (published only): every page-like collection. The single,
 * registry-driven source for public reachability — consumed by the access guard (runtime serving) and
 * the sitemap (which URLs to advertise), so a consumer's own pageLike collection is public without
 * editing a literal allow-list. Page-like ⟺ has a `path`, i.e. it is routable to a static URL.
 */
export function publicReadableResources(): string[] {
  return allCollections().filter((c) => c.def.pageLike).map((c) => c.def.name)
}
