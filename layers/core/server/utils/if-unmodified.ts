import { getHeader, type H3Event } from 'h3'

/** The optimistic-concurrency precondition header: the epoch-ms `updatedAt` the client last loaded. A
 *  bad/absent value means "no precondition" (unconditional write) rather than an error — so a plain API
 *  client that doesn't opt in still works. */
export const IF_UNMODIFIED_HEADER = 'x-kestrel-if-unmodified-since'

export function readIfUnmodifiedSince(event: H3Event): number | undefined {
  const raw = getHeader(event, IF_UNMODIFIED_HEADER)
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}
