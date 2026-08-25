import { extname } from 'node:path'

const MIME: Record<string, string> = {
  // markup / scripts / data
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
  // images
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.apng': 'image/apng',
  '.bmp': 'image/bmp',
  // fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  // audio / video
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/** MIME type for a static output file, inferred from its extension; octet-stream when unknown. A
 *  pre-compressed sibling (`app.js.br`) carries the encoding in `Content-Encoding`, so its type is the
 *  underlying asset's — strip a trailing `.br`/`.gz` before the lookup. Only strip it when a
 *  `Content-Encoding` will actually be sent (`hasEncoding`, default true for existing callers): a
 *  standalone archive with no such header must keep its own extension, or it ships mislabelled as the
 *  underlying (uncompressed) type — e.g. a browser trying to parse raw gzip bytes as JSON.
 * @public
 */
export function contentTypeFor(filename: string, hasEncoding = true): string {
  const base = hasEncoding ? filename.replace(/\.(?:br|gz)$/i, '') : filename
  return MIME[extname(base).toLowerCase()] ?? 'application/octet-stream'
}

/** The `Content-Encoding` for a precompressed sidecar (`app.js.br` beside `app.js`), or undefined for a
 *  standalone archive with no uncompressed base — tagging that would make a browser transparently decode
 *  genuine content and corrupt it. `siblingNames` are the file names in the same directory.
 * @public
 */
export function precompressedEncoding(filename: string, siblingNames: string[]): 'br' | 'gzip' | undefined {
  const m = /\.(br|gz)$/.exec(filename)
  if (!m || !siblingNames.includes(filename.slice(0, m.index))) return undefined
  return m[1] === 'br' ? 'br' : 'gzip'
}

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const REVALIDATE_CACHE = 'public, max-age=0, must-revalidate'

/** Artifacts served at a LITERAL key (not `<path>/index.html`) and rendered from the live DB rather than
 *  copied from the build. One list, because each of them has to be handled the same way in four places:
 *  re-rendered on every publish, excluded from the build-asset mirror (a stale copy must never overwrite
 *  a fresh one), seeded into the prerender routes, and cached as revalidate-always below.
 *  `llms-full.txt` is opt-in (`kestrel.seo.llmsFull`) and simply renders to a 404 when off — it stays in
 *  this list either way, so the rules that are about the FILENAME hold regardless of the flag; only the
 *  prerender seeding, which asks for the ROUTE, has to consult it.
 * @public
 */
export const META_KEYS = ['sitemap.xml', 'robots.txt', 'llms.txt', 'llms-full.txt', 'redirects.json'] as const

/** Whether `key` is one of {@link META_KEYS} — the crawler/agent artifacts rendered fresh from the live
 *  DB on every publish rather than copied from the build.
 * @public
 */
export function isMetaKey(key: string): boolean {
  return (META_KEYS as readonly string[]).includes(key)
}

/**
 * `Cache-Control` for a static-output key, or `undefined` for no explicit policy. Content-hashed
 * `_nuxt/` assets get a year + `immutable` (the hash is the cache key — new content ⇒ new URL). HTML and
 * the `META_KEYS` artifacts live at *stable* URLs whose content changes on any deploy, so they get
 * `max-age=0, must-revalidate` (cacheable but always revalidated) — `redirects.json` especially, since a
 * cached copy keeps serving withdrawn redirects. Everything else (favicons, fonts, un-hashed media) is
 * left to the host default.
 * @public
 */
export function cacheControlFor(key: string): string | undefined {
  // Nuxt's app manifest lives at a STABLE _nuxt URL but its content (the buildId) changes every build, so it
  // must revalidate — else the immutable rule below pins it and clients never detect a new deploy.
  if (key === '_nuxt/builds/latest.json') return REVALIDATE_CACHE
  if (key === '_nuxt' || key.startsWith('_nuxt/')) return IMMUTABLE_CACHE
  const base = key.split('/').pop() ?? key
  if (base.endsWith('.html') || isMetaKey(base)) return REVALIDATE_CACHE
  return undefined
}
