// Internal links inside richtext are stored as a marker href `kestrel:<collection>:<id>` (the editor
// sets it via the normal Link mark; sanitize allows the `kestrel:` scheme). At read time the marker is
// rewritten to the target's real localized path — the richtext counterpart of the `link` field's
// server populator. Pure string helpers, shared by the server populate pass and the client preview.

/** URL scheme that flags an internal richtext link (`kestrel:<collection>:<id>`); shared with sanitize. */
export const RICHTEXT_LINK_SCHEME = 'kestrel'

const MARKER_HREF = new RegExp(`href="${RICHTEXT_LINK_SCHEME}:([a-zA-Z0-9_-]+):(\\d+)"`, 'g')
const MARKER_VALUE = new RegExp(`^${RICHTEXT_LINK_SCHEME}:([a-zA-Z0-9_-]+):(\\d+)$`)

/** The marker href the editor stores for an internal richtext link. */
export function richtextLinkHref(collection: string, id: number): string {
  return `${RICHTEXT_LINK_SCHEME}:${collection}:${id}`
}

/**
 * Parse a bare `kestrel:<collection>:<id>` marker href back to its `{collection, id}` (the inverse of
 * `richtextLinkHref`); returns `null` for an ordinary/external anchor, a malformed marker, or non-string
 * input. Used by the toolbar to prefill the internal-link picker when re-editing an existing link.
 */
export function parseRichtextLinkHref(href: string | null | undefined): { collection: string; id: number } | null {
  if (typeof href !== 'string') return null
  const m = href.match(MARKER_VALUE)
  return m ? { collection: m[1]!, id: Number(m[2]) } : null
}

/** Every internal-link `{collection, id}` referenced by marker hrefs in the HTML (for batch resolve). */
export function collectRichtextRefs(html: string | null | undefined): { collection: string; id: number }[] {
  if (!html) return []
  return [...html.matchAll(MARKER_HREF)].map((m) => ({ collection: m[1]!, id: Number(m[2]) }))
}

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/**
 * Rewrite every `kestrel:<collection>:<id>` marker href to whatever the injected resolver returns; a
 * target the resolver declines becomes `#`. The production resolver is status-gated, so that covers a
 * missing target AND a draft one. Ordinary anchors are left untouched. Non-string input → `''`.
 */
export function resolveRichtextLinks(
  html: string | null | undefined,
  resolveHref: (collection: string, id: number) => string | null,
): string {
  if (typeof html !== 'string' || !html) return ''
  return html.replace(MARKER_HREF, (_m, collection: string, idStr: string) =>
    `href="${escapeAttr(resolveHref(collection, Number(idStr)) ?? '#')}"`)
}
