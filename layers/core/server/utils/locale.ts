import { createError } from 'h3'
import { resolveServerKestrel, serverRuntimeConfig } from './server-config'

// Website/content locales — the languages published *content* exists in. NOT the admin-UI language
// (that stays single-language English for now). Resolved lazily: prefer `runtimeConfig.public` (populated
// by the kestrel module from the consumer's `kestrel: {}`), falling back to Kestrel's own config file +
// env for non-Nitro callers (node tests, build time). Lazy so the consumer's config wins at request time
// rather than baking in the package's empty config at module-load.
function resolved(): { supported: readonly string[]; primary: string; prefixPrimary: boolean } {
  const pub = serverRuntimeConfig()?.public as { locales?: string[]; primaryLocale?: string; prefixPrimary?: boolean } | undefined
  if (pub?.locales?.length && pub.primaryLocale) return { supported: pub.locales, primary: pub.primaryLocale, prefixPrimary: pub.prefixPrimary === true }
  const r = resolveServerKestrel()
  return { supported: r.supportedLocales, primary: r.primaryLocale, prefixPrimary: r.prefixPrimary }
}

export function supportedLocales(): readonly string[] {
  return resolved().supported
}

export function primaryLocale(): string {
  return resolved().primary
}

/** Whether the primary locale is prefixed in URLs too (`/en/about`) — the `localePath` /
 *  `resolvePublicRoute` `prefixPrimary` flag, resolved from config. Default false. */
export function prefixPrimaryLocale(): boolean {
  return resolved().prefixPrimary
}

export type Locale = string

function normalizeLocale(value?: string | string[] | null): string {
  const single = Array.isArray(value) ? value[0] : value
  return (single ?? '').trim().toLowerCase()
}

export function isSupportedLocale(value: string): value is Locale {
  return supportedLocales().includes(value)
}

/**
 * Normalize a locale from a write body or a read query: trim + lowercase, default to the
 * primary locale when absent, throw 400 when explicitly given but unsupported. Shared by the
 * write and read paths so a WHERE filter and the populate locale can never drift apart.
 */
export function resolveLocale(value?: string | string[] | null): Locale {
  const normalized = normalizeLocale(value)
  if (!normalized) return primaryLocale()
  if (!isSupportedLocale(normalized)) {
    throw createError({ statusCode: 400, statusMessage: `Unsupported locale: ${normalized}` })
  }
  return normalized
}
