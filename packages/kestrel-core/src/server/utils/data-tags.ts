/** The data tag naming a translation group. `#` keeps it clear of the `<coll>:<id>` record namespace.
 * @public
 */
export function translationGroupTag(coll: string, group: string): string {
  return `${coll}#group:${group}`
}

/**
 * The data tag naming a page-like PATH rather than a record — the edge a DESCENDANT's breadcrumb hangs on.
 *
 * It has to be the path, because Kestrel has no parent/child relation between pages: `path` is a plain
 * column, a slug is flat unless an editor types slashes into it, and "descendant" is nothing but a
 * path-prefix match. So the case that matters most — a page CREATED at `/blog` after `/blog/hello` was
 * already published — has no record id that anything could have captured beforehand. A path, by contrast,
 * is knowable before its page exists, so a descendant subscribes to the path it looked in.
 *
 * Deliberately locale-LESS: a non-translatable record has no locale to name, and a descendant looking up
 * `/blog` in its own locale must still be reached when the page that appears there is a locale-less one.
 * It therefore over-approximates across locales (an `en` `/blog` write also re-renders a `de` descendant
 * of the same spelling) — extra renders, never a stale page.
 *
 * The leading `#` keeps it clear of the `<coll>` and `<coll>:<id>` namespaces (a collection name never
 * starts with one).
 * @public
 */
export function pagePathTag(path: string): string {
  return `#path:${path}`
}
