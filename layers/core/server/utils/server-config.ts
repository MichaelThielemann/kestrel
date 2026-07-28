import kestrelConfig from '../../../../kestrel.config'
import { resolveKestrel } from './kestrel-config'

/**
 * The Nitro runtimeConfig, or `undefined` for non-Nitro callers (node scripts, build) so they don't
 * throw on `useRuntimeConfig()`. Server utils prefer the values the kestrel module put here (from the
 * consumer's `kestrel: {}`), falling back to `resolveServerKestrel()` when it isn't populated.
 */
export function serverRuntimeConfig(): { kestrel?: Record<string, unknown>; public?: Record<string, unknown> } | undefined {
  return typeof useRuntimeConfig === 'function'
    ? (useRuntimeConfig() as { kestrel?: Record<string, unknown>; public?: Record<string, unknown> })
    : undefined
}

/** Resolve Kestrel's own config file + env — the fallback when runtimeConfig isn't populated. */
export function resolveServerKestrel(): ReturnType<typeof resolveKestrel> {
  return resolveKestrel(kestrelConfig, process.env, process.cwd())
}
