/**
 * Map a public route to its static HTML file key, mirroring Nitro's prerender layout:
 * `/` → `index.html`, `/about` → `about/index.html`, `/de/x` → `de/x/index.html`.
 * Throws on a route that can't be a safe relative key (traversal `..`, query `?`, fragment `#`,
 * or a backslash) so a bad path can never escape the output dir / S3 prefix.
 */
export function htmlKeyForRoute(route: string): string {
  if (/[?#\\]/.test(route) || route.split('/').some((seg) => seg === '..')) {
    throw new Error(`unsafe route for a static key: ${JSON.stringify(route)}`)
  }
  const trimmed = route.replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmed === '' ? 'index.html' : `${trimmed}/index.html`
}
