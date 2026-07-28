import { describe, it, expect } from 'vitest'
import { PRESETS, matchPreset, fitScale, resolveDim, clampDim, DIM_MIN, WIDTH_MAX, HEIGHT_MAX } from './preview-viewport'

describe('PRESETS — reference resolutions (desktop = config width + Auto height, tablet/mobile fixed)', () => {
  it('injects the desktop width with an Auto (fill) height; tablet/mobile are fixed device viewports', () => {
    expect(PRESETS(1440).map((p) => [p.key, p.w, p.h])).toEqual([
      ['desktop', 1440, 'auto'],
      ['tablet', 768, 1024],
      ['mobile', 390, 844],
    ])
    expect(PRESETS(1280)[0]!.w).toBe(1280)
  })

  it('each carries the toolbar icon + i18n label key', () => {
    expect(PRESETS(1440).map((p) => [p.icon, p.label])).toEqual([
      ['monitor', 'preview.device.desktop'],
      ['tablet', 'preview.device.tablet'],
      ['smartphone', 'preview.device.mobile'],
    ])
  })
})

describe('matchPreset — which preset a (w,h) is, else "custom" (drives the active highlight)', () => {
  const p = PRESETS(1440)
  it('matches on exact width AND height, including the Auto desktop height', () => {
    expect(matchPreset(1440, 'auto', p)).toBe('desktop')
    expect(matchPreset(768, 1024, p)).toBe('tablet')
    expect(matchPreset(390, 844, p)).toBe('mobile')
  })
  it('is "custom" when either dimension differs — incl. a stale numeric desktop height from an old cookie', () => {
    expect(matchPreset(1440, 900, p)).toBe('custom')
    expect(matchPreset(1024, 'auto', p)).toBe('custom')
    expect(matchPreset(391, 844, p)).toBe('custom')
  })
})

describe('fitScale — uniform scale fitting each FIXED axis into its avail, never upscaling; Auto axes free', () => {
  it('is width-limited when height is Auto (the Auto axis never constrains)', () => {
    expect(fitScale(720, 600, 1440, 'auto')).toBeCloseTo(0.5)
    expect(fitScale(720, 99999, 1440, 'auto')).toBeCloseTo(0.5) // a huge/short pane height is irrelevant
  })
  it('fits BOTH fixed axes for tablet/mobile (the min over the two ratios)', () => {
    expect(fitScale(400, 800, 768, 1024)).toBeCloseTo(Math.min(1, 400 / 768, 800 / 1024)) // ≈0.520, width-tight
  })
  it('caps at 1× so a frame smaller than the pane stays 1:1 (no blurry upscale)', () => {
    expect(fitScale(1000, 1000, 390, 844)).toBe(1)
  })
  it('is 1 before the stage is measured (avail ≤ 0)', () => {
    expect(fitScale(0, 0, 1440, 'auto')).toBe(1)
    expect(fitScale(-10, -10, 768, 1024)).toBe(1)
  })
  it('is 1 when both axes are Auto (nothing constrains)', () => {
    expect(fitScale(900, 600, 'auto', 'auto')).toBe(1)
  })
})

describe('resolveDim — a Dim to real px: fixed passes through, Auto fills avail at the current scale', () => {
  it('fills an Auto axis so the SCALED px exactly equals the available px', () => {
    expect(resolveDim(600, 'auto', 0.5, 900)).toBe(1200) // 1200 * 0.5 === 600 → fills the pane
  })
  it('passes a fixed dimension straight through (scale/avail irrelevant)', () => {
    expect(resolveDim(900, 1440, 0.625, 900)).toBe(1440)
  })
  it('falls back for an unmeasured Auto axis (SSR/tests: avail ≤ 0 or scale ≤ 0)', () => {
    expect(resolveDim(0, 'auto', 1, 900)).toBe(900)
    expect(resolveDim(600, 'auto', 0, 900)).toBe(900)
  })
})

describe('clampDim — commit a numeric input: clamp to bounds + floor, null on junk (caller keeps previous)', () => {
  it('clamps into [min,max] and floors fractions', () => {
    expect(clampDim(1440.7, DIM_MIN, WIDTH_MAX)).toBe(1440)
    expect(clampDim(100, DIM_MIN, WIDTH_MAX)).toBe(DIM_MIN)
    expect(clampDim(9999, DIM_MIN, WIDTH_MAX)).toBe(WIDTH_MAX)
    expect(clampDim(5000, DIM_MIN, HEIGHT_MAX)).toBe(HEIGHT_MAX)
  })
  it('returns null for empty/non-finite input so the caller keeps the previous value', () => {
    expect(clampDim(null, DIM_MIN, WIDTH_MAX)).toBeNull()
    expect(clampDim(undefined, DIM_MIN, WIDTH_MAX)).toBeNull()
    expect(clampDim(Number.NaN, DIM_MIN, WIDTH_MAX)).toBeNull()
  })
})
