import { localePath } from '@michaelthielemann/kestrel-core'

export interface PageRouteRow {
  path: string | null
  locale: string
}

export function pagesToRoutes(rows: PageRouteRow[], primaryLocale: string, prefixPrimary = false): string[] {
  // The site root is the primary-locale home — `/` normally, `/<primary>` when the primary is prefixed.
  const routes = new Set<string>([localePath('/', primaryLocale, primaryLocale, prefixPrimary)])
  for (const { path, locale } of rows) {
    if (!path) continue
    routes.add(localePath(path, locale, primaryLocale, prefixPrimary))
  }
  return [...routes].sort()
}
