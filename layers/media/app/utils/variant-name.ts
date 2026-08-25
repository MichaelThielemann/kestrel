import type { VariantFit } from '@kestrel/core'

export interface VariantShape {
  width: number
  /** A fixed-box height (crop). null/undefined ⇒ proportional (width-only). */
  height?: number | null
  fit?: VariantFit
}

/**
 * Canonical stable name for a variant shape — the manifest/object-key stem. This ONE function is shared by
 * the render lookup (`KestrelImg` / `useMediaVariant`), the prerender scan that registers a discovered spec,
 * and (via the registry) `deriveImage`, so all three agree on the name. Names stay `[A-Za-z0-9_-]` so the
 * `<name>.<format>` manifest key and the relocate parser split cleanly on the last dot.
 */
export function variantName(shape: VariantShape): string {
  if (shape.height == null) return `w${shape.width}`
  const fit = shape.fit ?? 'cover'
  return fit === 'cover' ? `c${shape.width}x${shape.height}` : `c${shape.width}x${shape.height}-${fit}`
}
