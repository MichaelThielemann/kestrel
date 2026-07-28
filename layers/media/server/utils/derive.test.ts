import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { deriveImage } from './derive'
import { DEFAULT_IMAGE_POLICY } from '../../../core/server/utils/kestrel-config'

async function makePng(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer()
}

describe('deriveImage', () => {
  it('extracts dims + thumbhash and emits a variant per active spec × format, clamped to intrinsic width (no upscale)', async () => {
    const src = await makePng(800, 600)
    const r = await deriveImage(src, DEFAULT_IMAGE_POLICY)
    expect(r.width).toBe(800)
    expect(r.height).toBe(600)
    expect(typeof r.thumbhash).toBe('string')
    // default variants desugar the legacy widths → only w320,w640 fit (960+ skipped, > 800); each webp
    expect(r.variants.map((v) => v.name).sort()).toEqual(['w320', 'w640'])
    const w320 = r.variants.find((v) => v.name === 'w320')!
    expect({ width: w320.width, height: w320.height, format: w320.format, mime: w320.mime })
      .toEqual({ width: 320, height: 240, format: 'webp', mime: 'image/webp' })
    expect(r.variants.every((v) => Buffer.isBuffer(v.bytes))).toBe(true)
  })

  it('emits one variant per format and crops a fixed-box spec to its real output dims', async () => {
    const policy = {
      ...DEFAULT_IMAGE_POLICY,
      variants: [
        { name: 'thumb', width: 100, height: 100, fit: 'cover' as const, position: 'centre', formats: ['webp', 'jpeg'] as ('webp' | 'jpeg')[] },
        { name: 'w200', width: 200, height: null, fit: 'cover' as const, position: 'centre', formats: ['webp'] as ('webp' | 'jpeg')[] },
      ],
    }
    const r = await deriveImage(await makePng(800, 600), policy)
    const pick = (name: string, fmt: string) => r.variants.find((v) => v.name === name && v.format === fmt)!
    expect(r.variants).toHaveLength(3) // thumb×{webp,jpeg} + w200×webp
    expect({ w: pick('thumb', 'webp').width, h: pick('thumb', 'webp').height }).toEqual({ w: 100, h: 100 }) // cropped square
    expect(pick('thumb', 'jpeg').mime).toBe('image/jpeg')
    expect({ w: pick('w200', 'webp').width, h: pick('w200', 'webp').height }).toEqual({ w: 200, h: 150 }) // proportional
  })

  it('degrades a variant with a non-positive-integer height to a PROPORTIONAL resize (never crashes sharp)', async () => {
    // A malformed registry entry (e.g. height '' or 0) must not reach sharp's resize(w, <bad>) and throw —
    // it degrades to a width-only resize. Regression for the upload-500 the maintainer hit.
    const policy = {
      ...DEFAULT_IMAGE_POLICY,
      variants: [
        { name: 'w320', width: 320, height: '' as unknown as null, fit: 'cover', position: 'centre', formats: ['webp'] as ('webp' | 'jpeg')[] },
        { name: 'w640', width: 640, height: 0 as unknown as null, fit: 'cover', position: 'centre', formats: ['webp'] as ('webp' | 'jpeg')[] },
      ],
    }
    const r = await deriveImage(await makePng(800, 600), policy)
    expect(r.variants.map((v) => v.name).sort()).toEqual(['w320', 'w640'])
    expect(r.variants.find((v) => v.name === 'w320')!.height).toBe(240) // proportional (800×600 → 320×240), not a crop
  })

  it('reports EXIF-auto-oriented dimensions (orientation 5-8 swaps width/height)', async () => {
    // 200x100 landscape frame tagged orientation=6 → displays/renders as 100x200 portrait
    const src = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const r = await deriveImage(src, DEFAULT_IMAGE_POLICY)
    expect({ width: r.width, height: r.height }).toEqual({ width: 100, height: 200 })
  })
})
