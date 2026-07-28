import { createError, type H3Event } from 'h3'

/**
 * Per-handler write-authorization backstop. The access-guard middleware is the PRIMARY enforcement, but
 * it is gated on an `/api/` path-prefix string and is the only check — a future mutating route mounted
 * outside `/api/` (a `server/routes/*` action, a webhook), or any guard-vs-router path divergence, would
 * otherwise run unauthenticated. Every mutating handler calls this so authorization never depends solely
 * on that prefix heuristic. Throws 401 unless the resolved principal is the admin (the only role with
 * write grants — `renderer` is read-only, `anonymous` has no grants).
 */
export function requireAdmin(event: H3Event): void {
  if (event.context.principal?.role !== 'admin') {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}
