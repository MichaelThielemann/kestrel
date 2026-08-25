import { allCollections, pipelineAccess } from '@kestrel/core'
/**
 * Collections an anonymous visitor may read (published only). Derived from the read pipelines' own `access`
 * declarations, so there is ONE statement of public reachability: the declaration that admits an anonymous
 * read of a collection is the same one this list is built from. Consumed by the access guard (runtime
 * serving), the sitemap / llms.txt (which URLs to advertise) and the relation populator's reachability
 * predicate — a consumer's pageLike collection is public, and a consumer that overrides its read pipeline's
 * access moves it in or out of the set in one place.
 * @public
 */
export function publicReadableResources(): string[] {
  return allCollections()
    .filter((c) => pipelineAccess(c.def.name, 'readMany')?.public === true)
    .map((c) => c.def.name)
}
