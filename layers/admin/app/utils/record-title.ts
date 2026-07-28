/**
 * The text the editor header shows for a saved record: the `title` text field if present, else the first
 * text field — the SAME pick `slugSourceValue` (core/page-slug) derives the auto-slug from, so the heading
 * and the URL never disagree about which field is "the title".
 *
 * Returns `''` when there is no such field or its value is blank/non-string; the header then falls back to
 * the generic "Edit {collection} #{id}" (an id is all a brand-new record has).
 */
export function recordTitle(fields: Record<string, { type: string }>, values: Record<string, unknown>): string {
  const entries = Object.entries(fields)
  const pick = entries.find(([k, f]) => k === 'title' && f.type === 'text') ?? entries.find(([, f]) => f.type === 'text')
  if (!pick) return ''
  const v = values[pick[0]]
  return typeof v === 'string' ? v.trim() : ''
}
