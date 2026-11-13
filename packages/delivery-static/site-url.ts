/**
 * The canonical form of a site URL: an `http` or `https` URL without credentials, query or fragment, with its host
 * lower-cased, its default port dropped and its trailing slashes stripped. A base path is kept, so
 * `https://Example.org/de/` becomes `https://example.org/de`. Throws on anything else.
 */
export function normalizeSiteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`siteUrl ${JSON.stringify(value)} is not an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`siteUrl ${JSON.stringify(value)} must use http or https`);
  if (url.hostname === "") throw new Error(`siteUrl ${JSON.stringify(value)} has no host`);
  if (url.username !== "" || url.password !== "") throw new Error(`siteUrl ${JSON.stringify(value)} must not carry credentials`);
  if (url.search !== "" || url.hash !== "") throw new Error(`siteUrl ${JSON.stringify(value)} must not carry a query or a fragment`);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** The absolute URL of a delivered path under a normalized site URL: the site URL plus the path, so the home page ends in `/` and every other page has no trailing slash. Without a site URL, the path itself. */
export function pageUrl(siteUrl: string | undefined, path: string): string {
  return `${siteUrl ?? ""}${path}`;
}
