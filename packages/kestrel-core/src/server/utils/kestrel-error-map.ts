import { createError } from 'h3'
import type { KestrelError } from '@kestrel/contracts'

/** The one status/message map a `KestrelError` a step threw is translated through — called from exactly
 *  one place in production (`core/server/api/[...path].ts`'s `toHttpError`), factored out here so a test
 *  needing the real wire shape can reuse it without importing a route file (whose default export has the
 *  side effect of calling `defineEventHandler`, unavailable outside a server context). */
const KESTREL_ERROR_STATUS: Record<KestrelError['_tag'], number> = {
  NotFound: 404,
  Forbidden: 403,
  Unauthorized: 401,
  Conflict: 409,
  ValidationFailed: 400,
  Locked: 423,
  Quarantined: 409,
}

/** Consumer-facing contract surface: the guard an application's own error handling narrows an unknown
 *  thrown value to Kestrel's tagged error union with.
 * @public
 */
export function isKestrelError(error: unknown): error is KestrelError {
  if (typeof error !== 'object' || error === null || !('_tag' in error)) return false
  return (error as { _tag: string })._tag in KESTREL_ERROR_STATUS
}

function messageFor(error: KestrelError): string {
  switch (error._tag) {
    // A batch miss (load-before/publish populate `ids`) names every missing id, not just the first.
    case 'NotFound': return `${error.collection} ${(error.ids?.length ? error.ids : [error.id]).join(', ')} not found`
    // `reason` is already a complete, user-facing sentence at every construction site (a gate's own
    // evaluator message, or a step's) — prefixing the tag name here produced nonsense for gate-origin
    // reasons that already say "Forbidden"/start mid-sentence (e.g. the ip-allowlist gate's own message
    // IS "Forbidden"; the access gate's IS "Authentication required").
    case 'Forbidden': return error.reason
    case 'Unauthorized': return error.reason
    case 'Conflict': return error.details?.kind === 'stale'
      ? 'This record changed since you opened it. Reload to see the latest version before saving.'
      : `Conflict: duplicate ${error.field} "${error.value}"`
    // The specific text (per-field or otherwise) lives in issues[0].message; `data` carries the full list.
    case 'ValidationFailed': return error.issues[0]?.message ?? 'Validation failed'
    case 'Locked': return `Locked until ${error.until}`
    case 'Quarantined': return `Record ${error.id} is quarantined`
  }
}

/**
 * Translate a `KestrelError` into the matching h3 error; anything else — a `createError` that never
 * became a tagged error — passes through unchanged. Gate denials are themselves `KestrelError`s and
 * go through here too.
 * @public
 */
export function toHttpError(error: unknown): unknown {
  if (!isKestrelError(error)) return error
  return createError({
    statusCode: KESTREL_ERROR_STATUS[error._tag],
    statusMessage: messageFor(error),
    data: error._tag === 'ValidationFailed' ? error.issues : error._tag === 'Conflict' ? error.details : undefined,
  })
}
