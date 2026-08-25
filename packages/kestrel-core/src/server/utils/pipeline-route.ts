import { createError } from 'h3'

/** @public */
export interface PipelineRoute {
  /** `null` for a non-collection pipeline (`/api/login`). */
  collection: string | null
  pipeline: string
  id?: number
}

/**
 * The ONE place the URL grammar `/api/<collection>/<pipeline>[/<id>]` (and `/api/<pipeline>` for a
 * collection-less one) is decoded. Ids and pipeline names share a path position across the two forms, so
 * they are told apart by shape and by nothing else: a record id is a positive integer, a pipeline name
 * never is. Encoding that here — rather than at each call site — is what keeps `/api/pages/42` from being
 * read as a pipeline named "42".
 * @public
 */
export function parsePipelineRoute(path: string): PipelineRoute {
  const segments = (path.split('?')[0] ?? '').split('/').filter(Boolean)
  if (segments[0] !== 'api') throw notFound(path)
  const rest = segments.slice(1).map(decodeSegment)

  if (rest.length === 1) return { collection: null, pipeline: assertName(rest[0]!, path) }
  if (rest.length === 2) return { collection: rest[0]!, pipeline: assertName(rest[1]!, path) }
  if (rest.length === 3) return { collection: rest[0]!, pipeline: assertName(rest[1]!, path), id: parseRecordId(rest[2]!) }
  throw notFound(path)
}

const ID_PATTERN = /^[1-9][0-9]*$/

/** @public */
export function isRecordId(segment: string): boolean {
  return ID_PATTERN.test(segment)
}

/** @public */
export function parseRecordId(segment: string): number {
  if (!isRecordId(segment)) throw createError({ statusCode: 400, statusMessage: `Invalid id: ${segment}` })
  return Number(segment)
}

function assertName(segment: string, path: string): string {
  if (segment === '' || isRecordId(segment)) throw notFound(path)
  return segment
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function notFound(path: string): Error {
  return createError({ statusCode: 404, statusMessage: `Unknown endpoint: ${path.split('?')[0]}` })
}
