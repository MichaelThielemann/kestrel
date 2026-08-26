import { getMethod, getRequestHeader, sendRedirect, send, setHeader, setResponseStatus, type H3Event } from 'h3'
import { isRendererContext } from '@michaelthielemann/kestrel-access'
import { cacheControlFor, isDeliveryExemptPath, isDeliveryLive } from '@michaelthielemann/kestrel-core'
import { usePublishingDb, currentSnapshot, htmlKeyForRoute } from '@michaelthielemann/kestrel-publishing'
import { liveRedirectFor } from '@michaelthielemann/kestrel-delivery-live'

// Requests this adapter must never answer, whatever `currentSnapshot` says: the admin app, the pipeline
// API, Nitro's own internals (tasks — e.g. the manual `publish:run` trigger), built assets, and the
// editor's preview ticket flow. `META_ROUTES` mirrors `@michaelthielemann/kestrel-core`'s own `META_KEYS`
// (sitemap/robots/llms/redirects) — those are rendered by their own routes, not snapshots. Every prefix
// is slash-terminated (`normalizeExemptPrefix`'s own rule): a bare `/admin` would also match `/admin-guide`
// — a DIFFERENT, publishable route this adapter must still serve from its own snapshot.
const EXEMPT_PREFIXES = ['/api/', '/admin/', '/_nuxt/', '/_nitro/', '/__kestrel/']
const META_ROUTES = new Set(['/sitemap.xml', '/robots.txt', '/llms.txt', '/llms-full.txt', '/redirects.json'])

// EXEMPT_PREFIXES is slash-terminated the same way (see the const's own comment), so the bare form gets
// the same exact-path treatment `isDeliveryExemptPath` applies to the configured entries — matching only
// `startsWith(prefix)` left it unmatched, contrary to `deliveryExempt`'s own documented examples
// (`/health`, `/feed.xml`).
function isExempt(path: string): boolean {
  if (META_ROUTES.has(path)) return true
  if (path === '/admin') return true // the bare admin root has no trailing segment to anchor a '/admin/' prefix match
  if (EXEMPT_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))) return true
  return isDeliveryExemptPath(path)
}

// A route's own trailing slash is not a distinct route: '/route/' must resolve the same snapshot as
// '/route'. Only the FINAL slash is stripped (one normalization pass), so a prefix match like '/admin/'
// against '/admin/foo/' still sees '/admin/foo' and still starts with '/admin/'. The root path is its
// own fixed point and is never touched.
function normalizeTrailingSlash(path: string): string {
  return path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path
}

// RFC 7232 §3.2: If-None-Match may carry a comma-separated list of ETags, and a bare `*` matches any
// current representation (always a match, as long as the resource exists — checked by the caller).
// This route's ETag is always strong (`"<fingerprint>"`), so a weak validator (`W/"..."`) never matches
// under strong comparison, per the same section.
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false
  const trimmed = header.trim()
  if (trimmed === '*') return true
  return trimmed.split(',').some((candidate) => candidate.trim() === etag)
}

/**
 * The delivery-live catch-all: under `delivery: 'live'`, answers public content traffic exclusively from
 * `published_snapshots` — a configured redirect, 200 with the snapshot's own html, or 404. Wired as a
 * Nitro MIDDLEWARE (see `middleware/delivery-live-catchall.ts`) rather than a route, since a middleware
 * runs ahead of Nuxt's page router; middleware return values are ignored by h3, so this writes the
 * response itself and returns whether it did.
 *
 * Returns `false` (unhandled — the caller falls through to ordinary page rendering) for everything the
 * adapter must not touch: `delivery: 'static'` (the default), a response already sent, a non-GET/HEAD
 * request, a non-content path (admin/api/assets/meta/consumer-exempted routes), or the producer's OWN
 * internal render fetch. That last one is `isRendererContext()`/`import.meta.prerender` — the SAME
 * unforgeable AsyncLocalStorage marker `pipelines/route.ts` and `00.ip-allowlist.ts` already trust for
 * exactly this "is this our own in-process render, not an external request" question (`render-live.ts`'s
 * `renderRouteLive` runs its `localFetch` inside `runAsRenderer`, which sets it) — NOT a request header,
 * which any external client could forge. Without this bypass, a publish's own render would loop back
 * into this catch-all and get served its route's CURRENT (about-to-be-superseded) snapshot instead of
 * ever reaching a real page render, so a
 * publish under `'live'` could never record a fresh one.
 */
export async function serveLiveRoute(event: H3Event): Promise<boolean> {
  if (event.node?.res?.writableEnded) return false
  if (!isDeliveryLive()) return false
  if (import.meta.prerender === true || isRendererContext()) return false
  const method = getMethod(event)
  if (method !== 'GET' && method !== 'HEAD') return false
  const path = normalizeTrailingSlash(event.path.split('?')[0] || '/')
  if (isExempt(path)) return false

  // Live mode is the app's own edge — there is no separate njs/edge script in front of it the way the
  // static topology has, so a configured redirect has to be honoured here too, before the 404.
  const redirect = liveRedirectFor(path)
  if (redirect) {
    await sendRedirect(event, redirect.target, redirect.status)
    return true
  }

  const snapshot = currentSnapshot(usePublishingDb().db, path)
  if (!snapshot) {
    setResponseStatus(event, 404)
    await send(event, 'Not Found', 'text/plain')
    return true
  }

  // The fingerprint is a sha256 of the exact rendered bytes (publisher.ts), so a STRONG ETag is exact:
  // any two responses sharing it are byte-identical, never merely semantically equivalent. Cache-Control
  // mirrors delivery-static's own policy for an html key (`cacheControlFor`/`REVALIDATE_CACHE`) so the
  // two adapters agree on cacheability for the same snapshot. NOTE: this ETag/304 state lives only in
  // `published_snapshots`, read fresh per request — there is no separate in-process cache to invalidate,
  // so this is safe across multiple server processes sharing the DB.
  const etag = `"${snapshot.fingerprint}"`
  const cacheControl = cacheControlFor(htmlKeyForRoute(path))
  setHeader(event, 'etag', etag)
  if (cacheControl) setHeader(event, 'cache-control', cacheControl)

  if (ifNoneMatchHits(getRequestHeader(event, 'if-none-match'), etag)) {
    setResponseStatus(event, 304)
    await send(event, undefined)
    return true
  }

  const body = Buffer.from(snapshot.html, 'utf8')
  setHeader(event, 'content-length', body.byteLength)
  setResponseStatus(event, 200)
  await send(event, method === 'HEAD' ? undefined : snapshot.html, 'text/html; charset=utf-8')
  return true
}
