import { createError } from 'h3'
import { collectionEnabled, getResolvedKestrelConfig } from '@kestrel/core'
import mediaCollection from '../collections/media.js'

/**
 * Whether the `media` built-in is active for this consumer. The media routes are static files rather than
 * registry-driven, so they have to ask the SAME predicate the registry plugin and the schema engine use.
 * Without it a consumer who turned the built-in off keeps serving endpoints that query a table the schema
 * engine deliberately never created.
 * @public
 */
export function mediaCollectionEnabled(): boolean {
  return collectionEnabled(mediaCollection.def, getResolvedKestrelConfig().collections)
}

/** Route guard: with the built-in disabled the endpoint genuinely does not exist, so 404 — not a 500 from
 *  the missing table.
 * @public
 */
export function requireMediaCollection(): void {
  if (!mediaCollectionEnabled()) throw createError({ statusCode: 404, statusMessage: 'Media collection is disabled' })
}
