import { z } from 'zod'
import type { FieldDef } from './defineCollection'

export interface SeoMeta {
  title?: string
  description?: string
  noindex?: boolean
  /** Media id of the social-share image (og:image / twitter card); resolved under `seo.$media.image`. */
  image?: number | null
}

export const seoSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  noindex: z.boolean().optional(),
  image: z.number().int().positive().nullish(),
})

// The synthetic field set the row populator walks over the `seo` system column (PROPS key-mode), so the
// social image resolves through the registered media populator — same `$media` bag, same read-capture
// (a media change re-publishes every page whose og:image embeds it) as any real media field.
export const seoPopulateFields: Record<string, FieldDef> = {
  image: { type: 'media', options: { accept: 'image' } } as FieldDef,
}
