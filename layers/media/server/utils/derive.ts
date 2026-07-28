import sharp from 'sharp'
import { rgbaToThumbHash } from 'thumbhash'
import type { ResolvedImagePolicy } from '../../../core/server/utils/kestrel-config'

// The derivation policy is resolved once from kestrel config (KESTREL_MEDIA_IMAGE_* env → config → default)
// and threaded in by the upload handler. `DEFAULT_IMAGE_POLICY` is auto-imported from kestrel-config
// (the single export site); re-exporting it here would register a duplicate auto-import.
export type ImagePolicy = ResolvedImagePolicy

// Raster mimes that receive a derivative ladder. GIF is intentionally excluded: deriving WebP flattens it
// to a static first frame. Shared by the upload handler and the backfill task so they never disagree.
export const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif'])

export interface DerivedImage {
  width: number
  height: number
  thumbhash: string
  variants: { name: string; width: number; height: number; format: 'webp' | 'jpeg'; mime: string; bytes: Buffer }[]
}

export async function deriveImage(input: Buffer, policy: ImagePolicy): Promise<DerivedImage> {
  const meta = await sharp(input, { limitInputPixels: 268402689 }).metadata()
  // sharp's metadata reports the stored (pre-EXIF-rotation) dimensions; .rotate() only affects
  // the pixel pipeline. For EXIF orientation 5-8 (90°/270°, e.g. phone portrait photos) the
  // displayed image — and every variant below, which applies .rotate() — has width/height swapped.
  const swap = (meta.orientation ?? 0) >= 5
  const width = (swap ? meta.height : meta.width) ?? 0
  const height = (swap ? meta.width : meta.height) ?? 0

  const small = await sharp(input).rotate().resize(100, 100, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const thumbhash = Buffer.from(rgbaToThumbHash(small.info.width, small.info.height, small.data)).toString('base64')

  // Derive exactly the active variant set (name × format). A proportional spec wider than the source is
  // skipped (never upscale); a crop clamps via withoutEnlargement. The stored width/height are the REAL
  // pipeline-output dims (correct for crops and for clamped proportionals — not an aspect-ratio guess).
  const variants: DerivedImage['variants'] = []
  for (const spec of policy.variants) {
    // sharp throws on a non-positive-integer dimension — coerce so a malformed spec (e.g. a stale
    // `height: ''`) degrades to a proportional resize instead of 500ing the upload.
    const specWidth = toPosInt(spec.width)
    if (specWidth == null) continue
    const cropHeight = toPosInt(spec.height)
    if (cropHeight == null && width > 0 && specWidth > width) continue
    for (const format of spec.formats) {
      const resized = cropHeight == null
        ? sharp(input).rotate().resize({ width: specWidth, withoutEnlargement: true })
        : sharp(input).rotate().resize(specWidth, cropHeight, { fit: spec.fit, position: spec.position, withoutEnlargement: true })
      const encoded = format === 'jpeg' ? resized.jpeg({ quality: policy.jpegQuality }) : resized.webp({ quality: policy.webpQuality })
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
      variants.push({ name: spec.name, width: info.width, height: info.height, format, mime: format === 'jpeg' ? 'image/jpeg' : 'image/webp', bytes: data })
    }
  }
  return { width, height, thumbhash, variants }
}

function toPosInt(value: unknown): number | null {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? n : null
}
