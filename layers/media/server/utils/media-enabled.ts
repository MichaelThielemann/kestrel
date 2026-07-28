import { createError } from 'h3'
import { collectionEnabled } from '../../../core/server/schema/bootstrap'
import { resolveServerKestrel, serverRuntimeConfig } from '../../../core/server/utils/server-config'
import mediaCollection from '../collections/media'

/**
 * Whether the `media` built-in is active for this consumer. The media routes are static files rather than
 * registry-driven, so they have to ask the SAME predicate the registry plugin and the schema engine use.
 * Without it a consumer who turned the built-in off keeps serving endpoints that query a table the schema
 * engine deliberately never created.
 */
export function mediaCollectionEnabled(): boolean {
  const toggles = (serverRuntimeConfig()?.kestrel?.collections ?? resolveServerKestrel().collections) as
    | Record<string, boolean>
    | undefined
  return collectionEnabled(mediaCollection.def, toggles)
}

/** Route guard: with the built-in disabled the endpoint genuinely does not exist, so 404 — not a 500 from
 *  the missing table. */
export function requireMediaCollection(): void {
  if (!mediaCollectionEnabled()) throw createError({ statusCode: 404, statusMessage: 'Media collection is disabled' })
}
