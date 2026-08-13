/**
 * The postMessage protocol between the admin block editor (parent window) and the live-preview iframe
 * (the real public page in preview mode). Pure — shared by both sides and unit-tested here; the DOM
 * wiring lives in the editor's preview host and the public `KestrelPreviewBridge`.
 *
 * Every message carries a `kestrel: 'preview:*'` discriminant so foreign postMessage traffic (HMR,
 * browser extensions) can never be mistaken for ours. Parsing is direction-specific: the frame only
 * accepts editor→frame types and vice versa — a reflected/echoed message parses to `null`.
 * SECURITY: parsing validates SHAPE only. Both sides must additionally check `event.origin` against
 * their own origin and `event.source` against the expected window before trusting a message —
 * otherwise any page that embeds the site (or is embedded by it) could inject content.
 */

/** Query flag that switches the public page into preview mode (value `1`). */
export const PREVIEW_QUERY = 'kestrel-preview'
/** Query carrying a preview TICKET — the editor's unsaved state, rendered in a normal tab (ADR-0008). */
export const PREVIEW_TOKEN_QUERY = 'kestrel-preview-token'
/** Dedicated preview page for records without a public URL (new/unsaved, non-pageLike). Admin-gated. */
export const PREVIEW_FALLBACK_PATH = '/__kestrel/preview'

/** The block-node shape the renderer consumes (already media/link-populated by the editor). */
export interface PreviewBlockNode { id?: string; type: string; props?: Record<string, unknown>; slots?: Record<string, unknown> }

/** editor → frame: the live (populated) block tree + the current selection. */
export interface PreviewContentMessage { kestrel: 'preview:content'; blocks: PreviewBlockNode[]; selectedId: string | null }
/** editor → frame: selection changed (tree click) — highlight + scroll into view. */
export interface PreviewSelectedMessage { kestrel: 'preview:selected'; selectedId: string | null }
/** frame → editor: the bridge mounted (or the iframe reloaded) — (re)send the full state. */
export interface PreviewReadyMessage { kestrel: 'preview:ready' }
/** frame → editor: a block was clicked in the preview. */
export interface PreviewSelectMessage { kestrel: 'preview:select'; id: string }

export type EditorToFrameMessage = PreviewContentMessage | PreviewSelectedMessage
export type FrameToEditorMessage = PreviewReadyMessage | PreviewSelectMessage

export const contentMessage = (blocks: PreviewBlockNode[], selectedId: string | null): PreviewContentMessage =>
  ({ kestrel: 'preview:content', blocks, selectedId })
export const selectedMessage = (selectedId: string | null): PreviewSelectedMessage =>
  ({ kestrel: 'preview:selected', selectedId })
export const readyMessage = (): PreviewReadyMessage => ({ kestrel: 'preview:ready' })
export const selectMessage = (id: string): PreviewSelectMessage => ({ kestrel: 'preview:select', id })

function tagOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const tag = (data as { kestrel?: unknown }).kestrel
  return typeof tag === 'string' ? tag : null
}

/** Parse a message the FRAME received (editor → frame); `null` for anything else. */
export function parseEditorMessage(data: unknown): EditorToFrameMessage | null {
  const tag = tagOf(data)
  if (tag === 'preview:content') {
    const m = data as PreviewContentMessage
    return Array.isArray(m.blocks) && (m.selectedId === null || typeof m.selectedId === 'string') ? m : null
  }
  if (tag === 'preview:selected') {
    const m = data as PreviewSelectedMessage
    return m.selectedId === null || typeof m.selectedId === 'string' ? m : null
  }
  return null
}

/** Parse a message the EDITOR received (frame → editor); `null` for anything else. */
export function parseFrameMessage(data: unknown): FrameToEditorMessage | null {
  const tag = tagOf(data)
  if (tag === 'preview:ready') return data as PreviewReadyMessage
  if (tag === 'preview:select') {
    const m = data as PreviewSelectMessage
    return typeof m.id === 'string' ? m : null
  }
  return null
}

/**
 * The iframe URL for the editor's preview pane: the record's real public URL when it has one (saved
 * pageLike record — server-populated first paint, drafts included for the admin session), else the
 * dedicated fallback page (new/unsaved records, non-pageLike collections). Both carry the preview flag.
 */
/**
 * The record a ticket preview renders: the saved row with the editor's unsaved values laid over it. Both
 * halves are column-keyed (the editor sends what a save would send), so this is a shallow override — a
 * field the editor did not touch keeps the stored value, and a page that does not exist yet (an unsaved
 * slug) renders from the payload alone. Pure.
 */
export function previewPage(
  saved: Record<string, unknown> | null,
  values: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!values) return saved
  return { ...(saved ?? {}), ...values }
}

export function previewSrc(publicUrl: string | null, locale: string): string {
  if (publicUrl) return `${publicUrl}?${PREVIEW_QUERY}=1`
  const loc = locale ? `&locale=${encodeURIComponent(locale)}` : ''
  return `${PREVIEW_FALLBACK_PATH}?${PREVIEW_QUERY}=1${loc}`
}
