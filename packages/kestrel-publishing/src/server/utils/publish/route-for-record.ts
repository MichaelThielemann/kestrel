import { pageRowHref } from '@kestrel/core'

/**
 * The static route a page-like record publishes to, or null when it has none — a non-pageLike collection,
 * or a row with no `path` (a blank slug, or no row at all). Adds the `pageLike` gate on top of the shared
 * `pageRowHref` rule (the publish-status endpoint's null cases); the locale falls back to the primary for
 * a row without one (non-translatable).
 * @public
 */
export function routeForRecord(
  row: { path?: unknown; locale?: unknown } | null | undefined,
  pageLike: boolean,
  primaryLocale: string,
  prefixPrimary: boolean,
): string | null {
  return pageLike ? pageRowHref(row, primaryLocale, prefixPrimary) : null
}
