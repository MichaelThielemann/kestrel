import { usePreviewStore, previewOwner } from '../utils/preview-token'

/**
 * Read back a preview ticket (ADR-0008) — the public page fetches it during SSR when the URL carries
 * `?kestrel-preview-token=…` and renders the editor's unsaved state instead of the stored record. Admin-
 * only and session-bound; an expired, foreign or unknown token is `null`, which the page treats as
 * "nothing to preview" and falls back to the saved content rather than failing the render.
 */
export default defineEventHandler((event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const token = getQuery(event).token
  if (typeof token !== 'string' || !token) return null
  const payload = usePreviewStore().read(token, previewOwner(event))
  if (!payload) return null

  // The editor sends what a SAVE would send — raw ids for media and relations — so the ticket goes through
  // the same read population a stored record does. Without it the preview would render a page with the
  // images and internal links stripped, which is worse than useless for judging a layout.
  const c = getCollection(payload.collection)
  if (!c) return { payload }
  const locale = payload.locale || primaryLocale()
  const values = withResolveScope(
    () => populateRow({ ...payload.values }, { depth: 1, locale, def: c.def }),
    resolveBudgetFor(1),
    `preview ${payload.collection}`,
  )
  return { payload: { ...payload, values } }
})
