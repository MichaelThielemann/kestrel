import type { ResolvedKestrel } from './kestrel-config.js'

let resolved: ResolvedKestrel | undefined

/**
 * Set once at boot by the consuming layer's config-wiring plugin (reads `useRuntimeConfig()` /
 * `resolveServerKestrel()` with the app's own precedence, then calls this) — package code never touches
 * a Nuxt auto-import directly. Mirrors the registries' `seedBuiltinFieldTypes`-style seeding: the package
 * declares the seam, the consuming layer fills it at init.
 * @public
 */
export function setResolvedKestrelConfig(cfg: ResolvedKestrel): void {
  resolved = cfg
}

/**
 * Read the config `setResolvedKestrelConfig` was given. Throws loudly if boot wiring never ran — a
 * silent fallback (an empty/default config) would mask a missing plugin registration as some other,
 * harder-to-diagnose failure downstream.
 * @public
 */
export function getResolvedKestrelConfig(): ResolvedKestrel {
  if (!resolved) {
    throw new Error(
      '[kestrel] getResolvedKestrelConfig() called before setResolvedKestrelConfig() — the layer\'s '
      + 'config-wiring plugin must run first (see docs/internals/architecture.md § Server plugins).',
    )
  }
  return resolved
}

/**
 * Test-only reset, mirroring the `clearRegistry()`/`clearBlocks()` family elsewhere in this package.
 * @public
 */
export function clearResolvedKestrelConfig(): void {
  resolved = undefined
}
