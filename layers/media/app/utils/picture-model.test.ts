import { describe, it, expect } from 'vitest'
import { buildPictureModel, requestedNames, requestVariantSpecs, resolveSizes } from './picture-model'

const media = {
  id: 1, alt: 'Cat', title: null, description: null, mime: 'image/jpeg', width: 800, height: 600, thumbhash: 'TH',
  src: '/uploads/hero.jpg', srcset: [],
  variants: [
    { name: 'w320', format: 'webp', url: '/u/w320.webp', width: 320, height: 240 },
    { name: 'w320', format: 'jpeg', url: '/u/w320.jpeg', width: 320, height: 240 },
    { name: 'w640', format: 'webp', url: '/u/w640.webp', width: 640, height: 480 },
    { name: 'w640', format: 'jpeg', url: '/u/w640.jpeg', width: 640, height: 480 },
    { name: 'c100x100', format: 'webp', url: '/u/thumb.webp', width: 100, height: 100 },
  ],
}

describe('requestedNames', () => {
  it('derives names from widths + crop + explicit presets (deduped)', () => {
    expect(requestedNames({ widths: [320, 640] })).toEqual(['w320', 'w640'])
    expect(requestedNames({ crop: { width: 100, height: 100 } })).toEqual(['c100x100'])
    expect(requestedNames({ preset: ['thumb', 'hero'] })).toEqual(['thumb', 'hero'])
    expect(requestedNames({ widths: [320], preset: 'w320' })).toEqual(['w320']) // deduped
    // fractional / string dims are floored to match requestVariantSpecs' registered name (not w640.5)
    expect(requestedNames({ widths: [640.5] })).toEqual(['w640'])
    expect(requestedNames({ crop: { width: 100.9, height: 100.2 } })).toEqual(['c100x100'])
  })
})

describe('requestVariantSpecs (what the prerender scan registers)', () => {
  it('expands widths + crop × formats into registrable specs; does NOT expand named presets', () => {
    expect(requestVariantSpecs({ widths: [320, 640], formats: ['webp', 'jpeg'] })).toEqual([
      { name: 'w320', width: 320, height: null, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] },
      { name: 'w640', width: 640, height: null, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] },
    ])
    expect(requestVariantSpecs({ crop: { width: 320, height: 320 }, formats: ['webp'] })).toEqual([
      { name: 'c320x320', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp'] },
    ])
    expect(requestVariantSpecs({ preset: 'thumb' })).toEqual([]) // presets are config-resolved, not discovered
  })

  it('coerces string dims and drops a crop with a non-positive-integer dimension (never registers a bad box)', () => {
    expect(requestVariantSpecs({ widths: ['320' as unknown as number], formats: ['webp'] })[0]).toMatchObject({ name: 'w320', width: 320 })
    expect(requestVariantSpecs({ crop: { width: 320, height: '' as unknown as number }, formats: ['webp'] })).toEqual([])
    expect(requestVariantSpecs({ crop: { width: 320, height: 0 }, formats: ['webp'] })).toEqual([])
  })
})

describe('resolveSizes (sizes=auto graceful degradation)', () => {
  it('keeps auto only on lazy images; drops it (keeping any fallback) on eager ones', () => {
    expect(resolveSizes('auto', true)).toBe('auto')
    expect(resolveSizes('auto, 50vw', true)).toBe('auto, 50vw')
    expect(resolveSizes('auto, 50vw', false)).toBe('50vw') // eager: auto is inert
    expect(resolveSizes('auto', false)).toBeUndefined()
    expect(resolveSizes('(min-width:768px) 50vw, 100vw', true)).toBe('(min-width:768px) 50vw, 100vw')
    expect(resolveSizes(undefined, true)).toBeUndefined()
  })
})

describe('buildPictureModel', () => {
  it('emits a <source> per requested format (in preference order) with a w-descriptor srcset', () => {
    const m = buildPictureModel(media as never, { widths: [320, 640], formats: ['webp', 'jpeg'], sizes: '50vw' }, { lazy: true })
    expect(m.sources).toEqual([
      { type: 'image/webp', srcset: '/u/w320.webp 320w, /u/w640.webp 640w' },
      { type: 'image/jpeg', srcset: '/u/w320.jpeg 320w, /u/w640.jpeg 640w' },
    ])
    expect(m.src).toBe('/u/w640.jpeg') // largest of the last (most-compatible) format
    expect(m.sizes).toBe('50vw')
    expect(m.alt).toBe('Cat')
  })

  it('uses the cropped variant dims (avoids CLS) for a crop request', () => {
    const m = buildPictureModel(media as never, { crop: { width: 100, height: 100 }, formats: ['webp'] }, { lazy: false })
    expect(m.sources).toEqual([{ type: 'image/webp', srcset: '/u/thumb.webp 100w' }])
    expect(m.src).toBe('/u/thumb.webp')
    expect({ w: m.width, h: m.height }).toEqual({ w: 100, h: 100 })
  })

  it('defaults a lazy image with no sizes to "auto, 100vw" (strictly better than 100vw)', () => {
    expect(buildPictureModel(media as never, { widths: [320] }, { lazy: true }).sizes).toBe('auto, 100vw')
    expect(buildPictureModel(media as never, { widths: [320] }, { lazy: false }).sizes).toBeUndefined()
  })

  it('falls back to the original src (and no sources) when no requested variant exists yet', () => {
    const m = buildPictureModel(media as never, { widths: [9999], formats: ['webp'] }, { lazy: true })
    expect(m.sources).toEqual([])
    expect(m.src).toBe('/uploads/hero.jpg')
  })
})
