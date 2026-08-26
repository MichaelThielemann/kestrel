import { inArray, getTableColumns } from 'drizzle-orm'
import type { MediaDb } from '../db/media-db.js'
import { primaryLocale } from '@michaelthielemann/kestrel-core'
import { media } from '../collections/media.js'
import type { DerivativeManifest } from './record.js'

/** One derivative, tagged with its parsed name + format so `<picture>` rendering can group by format.
 * @public
 */
export interface MediaVariant { name: string; format: string; url: string; width: number; height: number }

/** The disclosure-relevant subset of the IPTC Digital Source Type vocabulary (EU AI Act Art. 50).
 * @public
 */
export type AiSourceType = 'trainedAlgorithmicMedia' | 'compositeWithTrainedAlgorithmicMedia' | 'algorithmicallyEnhanced'

/** The client-facing shape a media id resolves to: URLs, dimensions, variants, and its AI disclosure.
 * @public
 */
export interface ResolvedMedia {
  id: number
  /** The media's storage folder ('' at the media root) — lets the field open the picker there. */
  folder: string
  alt: string | null
  title: string | null
  description: string | null
  mime: string
  width: number | null
  height: number | null
  thumbhash: string | null
  src: string
  /** WebP-only responsive srcset (kept for the admin thumb/grid/field/viewer `<img>`s). */
  srcset: { url: string; width: number }[]
  /** Every derivative, name+format-tagged — the source `KestrelImg`/`useMediaVariant` build `<picture>` from. */
  variants: MediaVariant[]
  /** EU AI Act Art. 50 disclosure, set by an editor — null when unset. Always resolved regardless of
   *  `kestrel.config.ts`'s `aiDisclosure.enabled` (that flag only gates the admin UI). Kestrel never
   *  renders this automatically; read it directly or opt into `KestrelImg`'s `aiBadge` prop. */
  aiDisclosure: { sourceType: AiSourceType; note: string | null } | null
}

interface MediaRow {
  id: number
  folder: string | null
  storageKey: string
  mime: string
  width: number | null
  height: number | null
  thumbhash: string | null
  derivatives: DerivativeManifest | null
  translations: Record<string, { alt?: string; title?: string; description?: string }> | null
  aiSourceType: string | null
  aiNote: string | null
}

/** Resolves one media row into its client-facing `ResolvedMedia` shape for `locale`.
 * @public
 */
export function resolveMedia(row: MediaRow, locale: string, publicUrl: (key: string) => string): ResolvedMedia {
  // Per-FIELD locale fallback, not whole-locale: a locale entry that carries e.g. only `title` (the PATCH
  // API creates partial per-locale objects) must not suppress the primary's `alt` — that silently drops
  // accessibility text on that locale's pages. Each field falls back to the primary locale independently.
  const loc = row.translations?.[locale] ?? {}
  const prim = row.translations?.[primaryLocale()] ?? {}
  const t = { alt: loc.alt ?? prim.alt, title: loc.title ?? prim.title, description: loc.description ?? prim.description }
  // Every derivative, name+format-tagged (the manifest key is `<name>.<format>`; names are dot-free so the
  // last dot splits cleanly). `srcset` is the webp slice, kept for the admin `<img>`s.
  const variants = Object.entries(row.derivatives ?? {}).map(([mk, d]) => {
    const dot = mk.lastIndexOf('.')
    const name = dot > 0 ? mk.slice(0, dot) : mk
    const format = dot > 0 ? mk.slice(dot + 1) : (d.mime.split('/').pop() ?? '')
    return { name, format, url: publicUrl(d.key), width: d.width, height: d.height }
  })
  const srcset = variants
    .filter((v) => v.format === 'webp')
    .map((v) => ({ url: v.url, width: v.width }))
    .sort((a, b) => a.width - b.width)
  return {
    id: row.id,
    folder: row.folder ?? '', // root files store folder NULL → ''
    alt: t.alt ?? null,
    title: t.title ?? null,
    description: t.description ?? null,
    mime: row.mime,
    width: row.width,
    height: row.height,
    thumbhash: row.thumbhash,
    src: publicUrl(row.storageKey),
    srcset,
    variants,
    // A note without a source type is only evidence (e.g. the upload scan's pre-fill), not a disclosure —
    // never emit a half-filled object a consumer might render as one.
    aiDisclosure: row.aiSourceType ? { sourceType: row.aiSourceType as AiSourceType, note: row.aiNote ?? null } : null,
  }
}

/** Reorder rows to match the requested id order, dropping ids that resolved to nothing.
 * @public
 */
export function orderById<T extends { id: number }>(ids: number[], rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is T => !!r)
}

/** Resolves several media ids at once, in the requested order.
 * @public
 */
export function resolveManyByIds(db: MediaDb, ids: number[], locale: string, publicUrl: (key: string) => string): ResolvedMedia[] {
  if (!ids.length) return []
  const cols = getTableColumns(media) as Record<string, never>
  const rows = db.select().from(media).where(inArray(cols.id, ids)).all() as MediaRow[]
  return orderById(ids, rows.map((r) => resolveMedia(r, locale, publicUrl)))
}
