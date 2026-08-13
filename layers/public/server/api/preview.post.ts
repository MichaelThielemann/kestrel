import { usePreviewStore, previewOwner, type PreviewPayload } from '../utils/preview-token'

/** Editor payloads are form state, not uploads — a block tree with populated media is far below this. */
const MAX_PAYLOAD_BYTES = 2_000_000

/**
 * Mint a preview ticket for the editor's UNSAVED state (ADR-0008). The editor posts what it currently
 * holds and opens the page at `?kestrel-preview-token=<token>` in a new tab; nothing is written to the DB,
 * so previewing never doubles as an unasked-for save. Admin-only (default-deny API guard + the backstop),
 * and the ticket is bound to this session.
 *
 *   body: { collection, id: number | null, locale?, values }
 *   200:  { token, expiresAt }
 */
export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const body = (await readBody(event)) as Partial<PreviewPayload> | null

  const name = typeof body?.collection === 'string' ? body.collection : ''
  if (!getCollection(name)) throw createError({ statusCode: 404, statusMessage: `Unknown collection: ${name}` })

  const values = body?.values
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw createError({ statusCode: 400, statusMessage: 'preview requires a `values` object' })
  }
  if (JSON.stringify(values).length > MAX_PAYLOAD_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Preview payload too large' })
  }

  const id = typeof body?.id === 'number' && Number.isInteger(body.id) ? body.id : null
  const locale = typeof body?.locale === 'string' ? body.locale : undefined
  return usePreviewStore().mint(previewOwner(event), { collection: name, id, locale, values })
})
