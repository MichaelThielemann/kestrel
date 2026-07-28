/**
 * Whether a rail nav item linking to `base` (e.g. "/admin/posts") should read as active for the
 * current route `path`. Inclusive of descendant routes so a collection stays lit while editing one
 * of its records (/admin/posts/1) — Vue Router's record-based active match does not, because the
 * list and record pages are flat sibling routes that share no matched record.
 */
export function isNavItemActive(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`)
}
