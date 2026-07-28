/**
 * The public route path for a page row: other locales are prefixed with `/<locale>`; the primary locale
 * is unprefixed unless `prefixPrimary` is set (then it is prefixed too, root `/` → `/<primary>`). Single
 * source of truth for the URL scheme shared by the prerender routes, the sitemap, `populate-links`, the
 * `[...slug].vue` resolution, the slug-uniqueness check, and the admin SEO preview. Pure, so it is
 * unit-testable and safe to import from both server and app code.
 */
export function localePath(path: string, locale: string, primaryLocale: string, prefixPrimary = false): string {
  const p = path.startsWith('/') ? path : `/${path}`
  if (locale === primaryLocale && !prefixPrimary) return p
  return p === '/' ? `/${locale}` : `/${locale}${p}`
}
