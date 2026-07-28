import type { IconName } from '../../../ui/app/utils/icons'

/**
 * Pure geometry for the page-builder preview toolbar (device presets + automatic scale-to-fit + custom
 * W×H). Kept framework-free so it's node-testable — the Vue component (`BlockPreview.vue`) only wires refs
 * to these.
 */

/** A viewport axis: a fixed CSS px, or `'auto'` (fills the available pane at the current scale). */
export type Dim = number | 'auto'

export interface ViewportPreset {
  key: 'desktop' | 'tablet' | 'mobile'
  /** Toolbar glyph (registry key). */
  icon: IconName
  /** i18n label key (the resolution is shown alongside it in the tooltip). */
  label: string
  /** Reference viewport width/height — the iframe's REAL size (scaled only visually); `'auto'` fills. */
  w: Dim
  h: Dim
}

export type PresetKey = ViewportPreset['key'] | 'custom'

/** Bounds shared by the two numeric W×H inputs. */
export const DIM_MIN = 320
export const WIDTH_MAX = 3840
export const HEIGHT_MAX = 4320

/**
 * The three quick-select presets. Desktop keeps the config-driven breakpoint WIDTH (`kestrel.config.ts` →
 * `preview.desktopWidth`, default 1440) but an `'auto'` HEIGHT so the frame fills the pane vertically and
 * only the iframe's own document scrolls. Tablet/mobile are canonical fixed device viewports (iPad
 * portrait / iPhone) so `100vh`/sticky/lazy behave like the real device, scaled down to fit both axes.
 */
export function PRESETS(desktopWidth: number): ViewportPreset[] {
  return [
    { key: 'desktop', icon: 'monitor', label: 'preview.device.desktop', w: desktopWidth, h: 'auto' },
    { key: 'tablet', icon: 'tablet', label: 'preview.device.tablet', w: 768, h: 1024 },
    { key: 'mobile', icon: 'smartphone', label: 'preview.device.mobile', w: 390, h: 844 },
  ]
}

/** The preset a (w,h) exactly matches, else `'custom'` — drives which quick-select button is highlighted. */
export function matchPreset(w: Dim, h: Dim, presets: ViewportPreset[]): PresetKey {
  return presets.find((p) => p.w === w && p.h === h)?.key ?? 'custom'
}

/**
 * Uniform (no-distortion) scale: fit each FIXED axis into its available space, take the min, and **cap at
 * 1×** (never upscale). An `'auto'` axis doesn't constrain — it fills instead (see `resolveDim`). So
 * desktop (width fixed, height auto) is width-limited; tablet/mobile (both fixed) fit whichever axis is
 * tighter and letterbox the other. Returns 1 before the stage is measured (`avail ≤ 0`) so nothing jumps.
 */
export function fitScale(availW: number, availH: number, w: Dim, h: Dim): number {
  const ratios = [1]
  if (typeof w === 'number' && w > 0 && availW > 0) ratios.push(availW / w)
  if (typeof h === 'number' && h > 0 && availH > 0) ratios.push(availH / h)
  return Math.min(...ratios)
}

/**
 * Resolve a `Dim` to real px. A fixed value passes straight through; an `'auto'` axis fills the available
 * space at the current scale (`avail / scale`, so the SCALED px exactly equals `avail`). Falls back to
 * `fallback` when unmeasured (SSR/tests: `avail ≤ 0` or `scale ≤ 0`) so the frame still has a size.
 */
export function resolveDim(avail: number, dim: Dim, scale: number, fallback: number): number {
  if (dim !== 'auto') return dim
  return avail > 0 && scale > 0 ? Math.round(avail / scale) : fallback
}

/**
 * Commit a numeric-input value: clamp into `[min,max]` and floor to an integer px. Returns `null` for
 * empty/non-finite input so the caller keeps the previous value (the field can hold un-parsable editing
 * text whose model is momentarily null — we must not reset the viewport to a default then).
 */
export function clampDim(n: number | null | undefined, min: number, max: number): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, Math.floor(n)))
}
