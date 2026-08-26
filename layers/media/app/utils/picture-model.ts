import type { ResolvedMedia } from '@michaelthielemann/kestrel-media'
import type { VariantFit, VariantFormat, ResolvedVariant } from '@michaelthielemann/kestrel-core'
import { variantName } from './variant-name'

/** What a `KestrelImg` / `useMediaVariant` call declares it needs. One call may declare MULTIPLE sizes and
 *  formats: `widths` (proportional responsive set) and/or a fixed-box `crop`, plus named config `preset`s,
 *  crossed with `formats` (preference order, most-modern first). */
export interface VariantRequest {
  widths?: number[]
  crop?: { width: number; height: number; fit?: VariantFit }
  preset?: string | string[]
  formats?: VariantFormat[]
  /** The `<img sizes>` attribute; `auto` (or `auto, <fallback>`) is honoured on lazy images (see resolveSizes). */
  sizes?: string
}

export interface PictureSource { type: string; srcset: string }
export interface PictureModel {
  sources: PictureSource[]
  src: string
  width: number | null
  height: number | null
  alt: string
  sizes?: string
}

const MIME: Record<string, string> = { webp: 'image/webp', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', avif: 'image/avif', gif: 'image/gif' }

/**
 * `sizes=auto` lets the browser pick the srcset candidate from the image's rendered width, but ONLY on
 * lazy-loaded images — on eager ones it is inert. Non-supporting browsers ignore the `auto` keyword and use
 * the fallback after it, so `auto, 100vw` degrades to `100vw`. Hence: keep `auto` only when lazy (with any
 * fallback), and on an eager image drop the keyword, leaving just the fallback.
 */
export function resolveSizes(sizes: string | undefined, lazy: boolean): string | undefined {
  if (!sizes) return undefined
  const t = sizes.trim()
  if (/^auto\b/i.test(t)) {
    const fallback = t.slice(4).replace(/^\s*,\s*/, '').trim()
    if (!lazy) return fallback || undefined
    return fallback ? `auto, ${fallback}` : 'auto'
  }
  return t
}

/**
 * The concrete, registrable specs a request declares (for the prerender scan): each `width` → a
 * proportional `w<width>` spec, a `crop` → a fixed-box spec, both crossed with the request's formats.
 * Named `preset`s are NOT expanded — they are already config-resolved (referenced by name, not discovered).
 */
export function requestVariantSpecs(req: VariantRequest): ResolvedVariant[] {
  const formats: VariantFormat[] = req.formats?.length ? req.formats : ['webp']
  const out: ResolvedVariant[] = []
  // props may bind strings; drop any non-positive-integer dim so a bad spec is never registered (would crash sharp later)
  for (const raw of req.widths ?? []) {
    const w = posInt(raw)
    if (w != null) out.push({ name: variantName({ width: w }), width: w, height: null, fit: 'cover', position: 'centre', formats: [...formats] })
  }
  if (req.crop) {
    const w = posInt(req.crop.width)
    const h = posInt(req.crop.height)
    if (w != null && h != null) out.push({ name: variantName({ width: w, height: h, fit: req.crop.fit }), width: w, height: h, fit: req.crop.fit ?? 'cover', position: 'centre', formats: [...formats] })
  }
  return out
}

function posInt(value: unknown): number | null {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? n : null
}

/** The variant names a request targets: derived names for widths/crop + any explicit preset names.
 *  Applies the SAME posInt sanitisation as requestVariantSpecs so the render-lookup name matches the
 *  registered/derived name — otherwise a fractional width registers `w640` but looks up `w640.5`, and the
 *  derivative is never used. */
export function requestedNames(req: VariantRequest): string[] {
  const names: string[] = []
  for (const raw of req.widths ?? []) {
    const w = posInt(raw)
    if (w != null) names.push(variantName({ width: w }))
  }
  if (req.crop) {
    const w = posInt(req.crop.width)
    const h = posInt(req.crop.height)
    if (w != null && h != null) names.push(variantName({ width: w, height: h, fit: req.crop.fit }))
  }
  const presets = req.preset ? (Array.isArray(req.preset) ? req.preset : [req.preset]) : []
  names.push(...presets)
  return [...new Set(names)]
}

/**
 * Build the `<picture>` view-model for a resolved media + a variant request: one `<source>` per requested
 * format (in the request's preference order) whose srcset is the matching derivatives, and an `<img>`
 * fallback = the largest derivative of the LAST (most-compatible) format, or the original when none exist.
 * Pure — the load-bearing render logic, unit-tested without a DOM.
 */
export function buildPictureModel(media: ResolvedMedia, req: VariantRequest, opts: { lazy: boolean }): PictureModel {
  const names = new Set(requestedNames(req))
  const formats = (req.formats?.length ? req.formats : ['webp']) as string[]
  const pool = media.variants.filter((v) => names.has(v.name))

  const sources: PictureSource[] = []
  for (const fmt of formats) {
    const entries = pool.filter((v) => v.format === fmt).sort((a, b) => a.width - b.width)
    if (!entries.length) continue
    sources.push({ type: MIME[fmt] ?? `image/${fmt}`, srcset: entries.map((v) => `${v.url} ${v.width}w`).join(', ') })
  }

  // <img> fallback: the largest derivative of the last (most-compatible) requested format; else the original
  // (which may be a large PNG/AVIF, but is always a valid last resort).
  const lastFmt = formats[formats.length - 1]
  const lastEntries = pool.filter((v) => v.format === lastFmt).sort((a, b) => a.width - b.width)
  const fallback = lastEntries[lastEntries.length - 1]

  return {
    sources,
    src: fallback?.url ?? media.src,
    width: fallback?.width ?? media.width,
    height: fallback?.height ?? media.height,
    alt: media.alt ?? '',
    // Lazy images with no explicit sizes default to `auto, 100vw` — a strict upgrade over the 100vw default.
    sizes: resolveSizes(req.sizes ?? (opts.lazy ? 'auto, 100vw' : undefined), opts.lazy),
  }
}
