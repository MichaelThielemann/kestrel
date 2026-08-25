import { getRequestHeader } from 'h3'
import {
  MAX_JSON_BODY, assertBodyLimit, isRoutablePipeline, toHttpError, tryResolveDefaultPipeline,
  parseFilter, parsePipelineRoute, getCollectionOr404, useDb, readIfUnmodifiedSince,
} from '@kestrel/core'
import type { PipelineContext, PipelineTrace } from '@kestrel/core'
import { runPipelineForEventAuto, resolveEventPrincipal } from '@kestrel/access'
// The one handler behind the whole pipeline URL scheme:
//
//   GET  /api/<collection>/<readPipeline>[/<id>]
//   POST /api/<collection>/<writePipeline>[/<id>]
//   POST /api/<pipeline>                            (collection-less: login, publish, createPreview)
//
// It is the ONLY route file under server/api: every endpoint is a pipeline, and this is where each one is
// resolved, verb-checked and run.

/** Reads take their whole input from the query string, in the shape the read steps expect. One builder for
 *  every read pipeline — the generic list/detail reads and the editor's tooling reads pick the keys they
 *  need out of the same object. */
function readInput(query: Record<string, unknown>): Record<string, unknown> {
  return {
    ...query,
    locale: query.locale as string | undefined,
    sort: query.sort as string | undefined,
    page: query.page ? Number(query.page) : undefined,
    perPage: query.perPage ? Number(query.perPage) : undefined,
    filter: parseFilter(query),
    depth: query.depth ? Number(query.depth) : 0,
  }
}

function assertMethod(method: string, read: boolean, pipeline: string): void {
  const allowed = read ? method === 'GET' || method === 'HEAD' : method === 'POST'
  if (!allowed) {
    throw createError({ statusCode: 405, statusMessage: `${pipeline} is a ${read ? 'read' : 'write'} pipeline — use ${read ? 'GET' : 'POST'}` })
  }
}

/** Embed the trace as a `$`-prefixed sidecar, matching the `$media`/`$translations` convention on rows. A
 *  batch/array result (createMany, duplicate) or a bare value (a not-found singleton's `null`) has no
 *  object to spread into, so it is wrapped under `data` instead. */
function embedTrace(result: unknown, trace: PipelineTrace): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return { data: result, $pipeline: trace }
  return { ...(result as Record<string, unknown>), $pipeline: trace }
}

function logPipelineRun(trace: PipelineTrace): void {
  const steps = trace.steps.map((s) => `${s.name}${s.status === 'ok' ? '' : `:${s.status}`}=${s.ms}ms`).join(' ')
  const pipeline = trace.collection ? `${trace.collection}/${trace.pipeline}` : trace.pipeline
  console.log(`[kestrel] pipeline ${pipeline} ${steps} total=${trace.ms}ms`)
}

export default defineEventHandler(async (event) => {
  const route = parsePipelineRoute(event.path)
  const collection = route.collection === null ? null : getCollectionOr404(route.collection)
  const resolved = tryResolveDefaultPipeline(route.collection, route.pipeline)
  if (!isRoutablePipeline(resolved)) {
    throw createError({ statusCode: 404, statusMessage: `Unknown pipeline: ${route.pipeline}` })
  }
  assertMethod(getMethod(event), resolved.read, route.pipeline)

  const query = getQuery(event) as Record<string, unknown>
  // The body is buffered HERE, before the pipeline's gates run — so it must be bounded, or an anonymous /
  // cross-site / IP-blocked caller could stream an unbounded body into memory before being refused.
  if (!resolved.read && !resolved.rawBody) assertBodyLimit(getRequestHeader(event, 'content-length'), MAX_JSON_BODY)
  let ctx: PipelineContext | undefined
  let result: unknown
  try {
    result = await runPipelineForEventAuto(event, {
      op: route.pipeline,
      collection,
      db: collection ? useDb() : null,
      id: route.id,
      locale: query.locale as string | undefined,
      // A `rawBody` pipeline owns its own body read (multipart, ciphertext, a size-capped stream), so the
      // router must not consume the stream first.
      input: resolved.read ? readInput(query) : resolved.rawBody ? undefined : await readBody(event),
      // Optimistic concurrency: the editor sends the baseline it loaded, and a stale save is refused with
      // 409. Only `updateOne` has a step that reads it.
      work: resolved.read ? {} : { expectedUpdatedAt: readIfUnmodifiedSince(event) },
      onContext: (c) => { ctx = c },
    })
  } catch (error) {
    // The ONE call site that turns a step-raised KestrelError into an HTTP response (see
    // utils/kestrel-error-map.ts); everything else (the runner, the drivers) passes it through untouched.
    // Gate denials (401/403) never reach here as a KestrelError — they're already createError-shaped by
    // the time they leave the runner (see runner.ts's denied/refused) and pass through unchanged.
    throw toHttpError(error)
  } finally {
    if (import.meta.dev && ctx) logPipelineRun(ctx.trace.toJSON())
  }
  if (route.pipeline === 'createOne' || route.pipeline === 'createMany') setResponseStatus(event, 201)

  if (ctx && query.debug === 'pipeline' && resolveEventPrincipal(event).role === 'admin') {
    return embedTrace(result, ctx.trace.toJSON())
  }
  return result
})
