import { Forbidden, Unauthorized } from '@michaelthielemann/kestrel-contracts'
import { toHttpError } from '@michaelthielemann/kestrel-core'
import { refreshAuthSession } from '@michaelthielemann/kestrel-auth'
import { claimedByPipelineRoute, resolveEventPrincipal } from '@michaelthielemann/kestrel-access'

export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/')) return // default-deny applies to the API only

  // Authorization itself belongs to the pipeline the URL names — its `access`/`csrf`/`ipAllowlist`
  // declarations, evaluated by the engine before step 1. Only the principal is resolved here, because the
  // gates need it and because the session refresh below is a property of the request, not of the route.
  event.context.principal = resolveEventPrincipal(event)

  // Default-deny for everything no pipeline claims — an unknown name, a wrong verb, a stray route a
  // consumer mounted under /api without declaring who may run it. The admin falls through instead, so the
  // router can still answer accurately (404 for an unknown pipeline, 405 for the wrong verb) without that
  // answer confirming to an anonymous prober which pipelines exist. For the same reason an anonymous
  // caller gets the access gate's 401 here, not a 403 — a 401/403 split would itself be the oracle.
  if (!claimedByPipelineRoute(getMethod(event), event.path) && event.context.principal.role !== 'admin') {
    // toHttpError is the same single translation every pipeline-thrown KestrelError goes through
    // (core/server/api/[...path].ts's catch) — this middleware runs before any pipeline, so it calls the
    // map directly instead of growing a second one.
    if (event.context.principal.role === 'anonymous') {
      throw toHttpError(new Unauthorized({ reason: 'Authentication required' }))
    }
    throw toHttpError(new Forbidden({ reason: 'Forbidden' }))
  }

  // Sliding-expiry: any authenticated API activity refreshes the session so it stays alive while in use and
  // auto-expires after `maxAge` of inactivity (idle logout). No-op for anonymous/public requests.
  refreshAuthSession(event)
})
