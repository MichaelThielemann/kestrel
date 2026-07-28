/**
 * Resolve the request locale + the lookup path from the URL path segments, matching the server routing
 * (`localePath`): every non-primary configured locale is prefixed `/<locale>/…`; the primary locale is
 * unprefixed unless `prefixPrimary` is set (then `/<primary>/…` too). A leading segment counts as a locale
 * prefix when it is a configured locale (the primary only when `prefixPrimary`); anything else is part of
 * the path under the primary locale. Pure (no runtime-config access) so it is unit-testable and not
 * en/de-hardcoded.
 */
/** Config shape read off `runtimeConfig.public` (a subset). */
export interface PublicLocaleConfig {
  locales?: unknown
  primaryLocale?: unknown
  prefixPrimary?: unknown
}

/**
 * Resolve the configured content locales from a `runtimeConfig.public`-shaped object. Pure, so the
 * fallback/primary logic is unit-testable without a Nuxt context, and lives in the PUBLIC layer so
 * public code (the catch-all page + `usePublicLocale`) never has to reach into `layers/admin` for it.
 * The `['en']` fallback is a safe last resort for an absent/empty config (nuxt.config always sets
 * `public.locales`); primary-only is a safer guess than assuming a second locale exists.
 */
export function pickPublicLocales(pub: PublicLocaleConfig): {
  locales: string[]
  primary: string
  prefixPrimary: boolean
} {
  const locales = Array.isArray(pub.locales) && pub.locales.length ? pub.locales.map(String) : ['en']
  const primary =
    typeof pub.primaryLocale === 'string' && locales.includes(pub.primaryLocale) ? pub.primaryLocale : locales[0]!
  return { locales, primary, prefixPrimary: pub.prefixPrimary === true }
}

export function resolvePublicRoute(
  segments: string[],
  locales: string[],
  primaryLocale: string,
  prefixPrimary = false,
): { locale: string; path: string } {
  const head = segments[0]?.toLowerCase()
  const prefixed = head !== undefined && locales.includes(head) && (head !== primaryLocale || prefixPrimary)
  const locale = prefixed ? head : primaryLocale
  const rest = prefixed ? segments.slice(1) : segments
  const path = ('/' + rest.join('/')).toLowerCase().replace(/\/+$/, '') || '/'
  return { locale, path }
}
