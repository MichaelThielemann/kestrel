import { createError } from 'h3'
import { Effect } from 'effect'
import { ValidationFailed } from '@kestrel/contracts'
import { definePipeline, eventOf, getCollection, populateRow, primaryLocale, resolveBudgetFor, syncStep, withResolveScope } from '@kestrel/core'
import type { BuiltCollection, PipelineDef, StepDef } from '@kestrel/core'
import { sanitizePreviewValues } from '../utils/content/preview-sanitize.js'
import { previewOwner, usePreviewStore, type PreviewPayload } from '../utils/content/preview-token.js'

/** Editor payloads are form state, not uploads — a block tree with populated media is far below this. */
const MAX_PAYLOAD_BYTES = 2_000_000

/**
 * Read back a preview ticket (ADR-0008) — the public page fetches it during SSR when the URL carries
 * `?kestrel-preview-token=…` and renders the editor's unsaved state instead of the stored record. Admin-
 * only and session-bound; an expired, foreign or unknown token is `null`, which the page treats as
 * "nothing to preview" and falls back to the saved content rather than failing the render.
 */
const readTicket: StepDef = syncStep('readTicket', (ctx) => Effect.sync(() => {
  ctx.output = null
  const token = (ctx.input as { token?: unknown } | undefined)?.token
  if (typeof token !== 'string' || !token) return
  const payload = usePreviewStore().read(token, previewOwner(eventOf(ctx)))
  if (!payload) return

  // The editor sends what a SAVE would send — raw ids for media and relations — so the ticket goes through
  // the same read population a stored record does. Without it the preview would render a page with the
  // images and internal links stripped, which is worse than useless for judging a layout.
  const c = getCollection(payload.collection)
  if (!c) {
    ctx.output = { payload }
    return
  }
  const locale = payload.locale || primaryLocale()
  const values = withResolveScope(
    () => populateRow({ ...payload.values }, { depth: 1, locale, def: c.def }),
    resolveBudgetFor(1),
    `preview ${payload.collection}`,
  )
  ctx.output = { payload: { ...payload, values } }
}))

/**
 * Mint a preview ticket for the editor's UNSAVED state (ADR-0008). The editor posts what it currently
 * holds and opens the page at `?kestrel-preview-token=<token>` in a new tab; nothing is written to the DB,
 * so previewing never doubles as an unasked-for save. The ticket is bound to this session.
 *
 *   body: \{ collection, id: number | null, locale?, values \}
 *   200:  \{ token, expiresAt \}
 */
const mintTicket: StepDef = syncStep('mintTicket', (ctx) => Effect.gen(function* () {
  const body = ctx.input as Partial<PreviewPayload> | null

  const name = typeof body?.collection === 'string' ? body.collection : ''
  const collection = getCollection(name) as BuiltCollection | undefined
  if (!collection) throw createError({ statusCode: 404, statusMessage: `Unknown collection: ${name}` })

  const values = body?.values
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['values'], message: 'preview requires a `values` object' }] }))
  }
  if (JSON.stringify(values).length > MAX_PAYLOAD_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Preview payload too large' })
  }
  sanitizePreviewValues(collection, values as Record<string, unknown>)

  const id = typeof body?.id === 'number' && Number.isInteger(body.id) ? body.id : null
  const locale = typeof body?.locale === 'string' ? body.locale : undefined
  ctx.output = usePreviewStore().mint(previewOwner(eventOf(ctx)), { collection: name, id, locale, values })
}))

/** Reading a ticket and minting one are two different operations, and the URL grammar gives a pipeline one
 *  verb — so they are two pipelines rather than a GET/POST pair on one name. */
/** @public */
export function buildPreviewPipelines(): PipelineDef[] {
  return [
    definePipeline({ name: 'preview', read: true, access: { role: 'admin' }, steps: [readTicket] }),
    definePipeline({ name: 'createPreview', access: { role: 'admin' }, steps: [mintTicket] }),
  ]
}
