export interface ContentLocales {
  /** Website/content locales (NOT the admin-UI language) — what the editor LocaleBar offers. */
  locales: string[]
  primary: string
  /** Whether the primary locale is prefixed in public URLs too (`/en/about`); the `localePath` flag. */
  prefixPrimary: boolean
}

/** Resolve the configured content locales from a `runtimeConfig.public`-shaped object. Pure, so the
 *  fallback/primary logic is unit-testable without a Nuxt context. The `['en']` fallback is a safe
 *  last resort for an absent/empty config (nuxt.config always sets `public.locales`): primary-only is
 *  a safer guess than assuming a second locale exists, so it intentionally differs from the server's
 *  `['en','de']` *default* (which applies only when KESTREL_LOCALES itself is unset). */
export function pickContentLocales(pub: { locales?: unknown; primaryLocale?: unknown; prefixPrimary?: unknown }): ContentLocales {
  const locales = Array.isArray(pub.locales) && pub.locales.length ? pub.locales.map(String) : ['en']
  const primary =
    typeof pub.primaryLocale === 'string' && locales.includes(pub.primaryLocale) ? pub.primaryLocale : locales[0]!
  return { locales, primary, prefixPrimary: pub.prefixPrimary === true }
}

export function useContentLocales(): ContentLocales {
  return pickContentLocales(useRuntimeConfig().public as { locales?: unknown; primaryLocale?: unknown; prefixPrimary?: unknown })
}
