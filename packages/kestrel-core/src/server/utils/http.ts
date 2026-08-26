import { createError, getRouterParam, type H3Event } from 'h3'
import { getCollection } from './registry.js'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'

/** @public */
export function getCollectionOr404(name: string): BuiltCollection {
  const collection = getCollection(name)
  if (!collection) throw createError({ statusCode: 404, statusMessage: `Unknown collection: ${name}` })
  return collection
}

/** @public */
export function requireCollection(event: H3Event): BuiltCollection {
  return getCollectionOr404(getRouterParam(event, 'collection') as string)
}

/** Upper bound for a JSON pipeline body the router buffers before the gates run — generous for any real
 * @public
 *  editor payload (rich block content, a bulk patch). `rawBody` pipelines own their read and their own cap. */
export const MAX_JSON_BODY = 1024 * 1024

/**
 * Refuse a request body h3 would otherwise buffer with no ceiling, BEFORE reading a byte of it: a
 * missing/garbage Content-Length means a chunked transfer (411), a declared over-cap length is a cheap 413.
 * A client can under-declare, so a caller that buffers the bytes itself re-asserts the cap on the result.
 * @public
 */
export function assertBodyLimit(contentLength: string | undefined, maxBytes: number): void {
  const len = Number(contentLength)
  if (contentLength === undefined || !Number.isFinite(len) || len < 0) {
    throw createError({ statusCode: 411, statusMessage: 'Length required' })
  }
  if (len > maxBytes) {
    throw createError({ statusCode: 413, statusMessage: 'Payload too large' })
  }
}

/** @public */
export function parseId(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw createError({ statusCode: 400, statusMessage: `Invalid id: ${raw}` })
  return Number(raw)
}

/** @public */
export function requireId(event: H3Event): number {
  return parseId(getRouterParam(event, 'id') as string)
}

/**
 * Parse a list of record ids — from a bulk request body (`number[]`) or a comma-separated query string
 * (`?ids=1,2,3`). Dedupes (preserving first-seen order) and rejects, with a clean 400: an empty list, any
 * element that is not a positive integer, or more than `cap` ids. The cap is enforced up front on the raw
 * input, so an oversized body is rejected without being fully walked and allocated. Shared by the `bulk`
 * command endpoint and the batched referrer lookup so both enforce the same id contract.
 * @public
 */
export function parseIdList(raw: unknown, cap: number): number[] {
  const parts: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  // Bound the work before parsing: reject an oversized input up front rather than iterating and building a
  // Set of a million ids just to 400. `parts.length` is an upper bound on the deduped result, so this also
  // subsumes any post-dedupe cap — a raw list that fits here can never exceed `cap` after deduping.
  if (parts.length > cap) throw createError({ statusCode: 400, statusMessage: `Too many ids (max ${cap})` })
  const ids: number[] = []
  const seen = new Set<number>()
  for (const p of parts) {
    const n = typeof p === 'number' ? p : typeof p === 'string' ? Number(p) : Number.NaN
    if (!Number.isInteger(n) || n <= 0) throw createError({ statusCode: 400, statusMessage: `Invalid id: ${String(p)}` })
    if (!seen.has(n)) { seen.add(n); ids.push(n) }
  }
  if (!ids.length) throw createError({ statusCode: 400, statusMessage: 'ids must be a non-empty list' })
  return ids
}
