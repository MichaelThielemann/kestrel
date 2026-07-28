import type { ComputedRef } from 'vue'

export interface PublicPageState {
  collection: string | null
  page: Record<string, unknown> | null
}

/** The record rendered by the catch-all page, shared with layouts (language menu & co.); the page and a
 *  layout share no other channel, so the catch-all mirrors its resolved `{ collection, page }` here. */
export const usePublicPageState = () =>
  useState<PublicPageState>('public-page', () => ({ collection: null, page: null }))

/** Content locale of the current public route, derived from the URL prefix scheme. Reads the locale set
 *  from `runtimeConfig.public` via the public-layer `pickPublicLocales` (NOT admin's `useContentLocales`,
 *  which would make the public site depend on `layers/admin`). */
export function usePublicLocale(): ComputedRef<string> {
  const route = useRoute()
  const { locales, primary, prefixPrimary } = pickPublicLocales(
    useRuntimeConfig().public as { locales?: unknown; primaryLocale?: unknown; prefixPrimary?: unknown },
  )
  return computed(
    () => resolvePublicRoute(route.path.split('/').filter(Boolean), locales, primary, prefixPrimary).locale,
  )
}
