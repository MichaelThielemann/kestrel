import { createError } from 'h3'
import { getResolvedKestrelConfig } from '@kestrel/core'

// Website/content locales — the languages published *content* exists in. NOT the admin-UI language
// (that stays single-language English for now). Read from the config the boot-time wiring plugin
// resolved once (`runtimeConfig.public` when the kestrel module populated it, else Kestrel's own config
// file + env) — see `getResolvedKestrelConfig`'s own doc for why this isn't a per-call Nuxt auto-import.
function resolved(): { supported: readonly string[]; primary: string; prefixPrimary: boolean } {
  const r = getResolvedKestrelConfig()
  return { supported: r.supportedLocales, primary: r.primaryLocale, prefixPrimary: r.prefixPrimary }
}

/** @public */
export function supportedLocales(): readonly string[] {
  return resolved().supported
}

/** @public */
export function primaryLocale(): string {
  return resolved().primary
}

/** Whether the primary locale is prefixed in URLs too (`/en/about`) — the `localePath` /
 * @public
 *  `resolvePublicRoute` `prefixPrimary` flag, resolved from config. Default false. */
export function prefixPrimaryLocale(): boolean {
  return resolved().prefixPrimary
}

/** @public */
export type Locale = string

function normalizeLocale(value?: string | string[] | null): string {
  const single = Array.isArray(value) ? value[0] : value
  return (single ?? '').trim().toLowerCase()
}

/** @public */
export function isSupportedLocale(value: string): value is Locale {
  return supportedLocales().includes(value)
}

/**
 * Normalize a locale from a write body or a read query: trim + lowercase, default to the
 * primary locale when absent, throw 400 when explicitly given but unsupported. Shared by the
 * write and read paths so a WHERE filter and the populate locale can never drift apart.
 * @public
 */
export function resolveLocale(value?: string | string[] | null): Locale {
  const normalized = normalizeLocale(value)
  if (!normalized) return primaryLocale()
  if (!isSupportedLocale(normalized)) {
    throw createError({ statusCode: 400, statusMessage: `Unsupported locale: ${normalized}` })
  }
  return normalized
}
