import { z } from 'zod'
import type { FieldDef } from './defineCollection'

export interface SeoMeta {
  title?: string
  description?: string
  noindex?: boolean
  /** Media id of the social-share image (og:image / twitter card); resolved under `seo.$media.image`. */
  image?: number | null
  /** Article metadata — schema.org `author` / `datePublished` / `keywords` on the page's JSON-LD node.
   *  Only offered and only published when `kestrel.seo.articleMeta` is on; the column always ROUND-TRIPS
   *  them, so turning the flag off hides and unpublishes existing values instead of destroying them. */
  author?: string
  /** ISO date (`YYYY-MM-DD`) or ISO datetime; `''` is the editor's cleared state. */
  publishedDate?: string
  /** Free-form comma-separated list (the spelling schema.org accepts verbatim). */
  keywords?: string
}

// A date is validated here rather than at emission time so a mistyped value surfaces in the editor,
// where it can be fixed — not silently as a missing `datePublished` in an artifact nobody looks at.
const isoDateish = z.string().refine(
  (v) => v === '' || /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v),
  { message: 'Expected a date (YYYY-MM-DD)' },
)

export const seoSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  noindex: z.boolean().optional(),
  image: z.number().int().positive().nullish(),
  author: z.string().optional(),
  publishedDate: isoDateish.optional(),
  keywords: z.string().optional(),
})

// The synthetic field set the row populator walks over the `seo` system column (PROPS key-mode), so the
// social image resolves through the registered media populator — same `$media` bag, same read-capture
// (a media change re-publishes every page whose og:image embeds it) as any real media field.
export const seoPopulateFields: Record<string, FieldDef> = {
  image: { type: 'media', options: { accept: 'image' } } as FieldDef,
}
