import { getCollection, isRoutablePipeline, parsePipelineRoute, tryResolveDefaultPipeline } from '@michaelthielemann/kestrel-core'
/**
 * Whether the pipeline router — not the legacy route guard — is the authority for this request. True only
 * when the URL parses as a pipeline route, names a registered collection (or none at all), resolves to a
 * boot-registered pipeline, and uses that pipeline's verb. Everything else, including a typo'd pipeline
 * name, stays with the guard so an anonymous probe still gets today's 401 rather than a 404 that confirms
 * which collections exist.
 * @public
 */
export function claimedByPipelineRoute(method: string, path: string): boolean {
  let route
  try {
    route = parsePipelineRoute(path)
  } catch {
    return false
  }
  if (route.collection !== null && !getCollection(route.collection)) return false
  const resolved = tryResolveDefaultPipeline(route.collection, route.pipeline)
  if (!isRoutablePipeline(resolved)) return false
  const verb = method.toUpperCase()
  return resolved.read ? verb === 'GET' || verb === 'HEAD' : verb === 'POST'
}
