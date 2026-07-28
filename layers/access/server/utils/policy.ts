export type Role = 'admin' | 'renderer' | 'anonymous'
export type Action = 'read' | 'write'
export interface Principal { userId: string | null; role: Role }
export interface Grant { action: Action; resource: string; scope?: 'published' | 'all' }
export interface AccessResult { allowed: boolean; readScope: 'published' | 'all' }

/** Hardcoded authorization policy. Role -> grants. `resource: '*'` matches any. */
export const POLICY: Record<Role, Grant[]> = {
  admin: [{ action: 'write', resource: '*' }, { action: 'read', resource: '*' }],
  // The renderer is ONLY ever the build-time prerender or the runtime publisher; both produce the
  // public static site, which is published-only by definition. Scope its read to 'published' so the
  // generic /api/<collection> reads never leak drafts into the generated HTML (admin live preview is
  // unaffected — it renders under the admin principal, scope 'all').
  renderer: [{ action: 'read', resource: '*', scope: 'published' }],
  // Anonymous published-read is data-driven from the registry (every page-like collection), not a
  // literal allow-list — see the `publicResources` branch in `resolveAccess`.
  anonymous: [],
}

export function resolveAccess(principal: Principal, action: Action, resource: string, publicResources: readonly string[] = [], extraGrants: readonly Grant[] = []): AccessResult {
  let allowed = false
  // readScope reflects the principal's READ permission for this resource, INDEPENDENT of the requested
  // action, and is fail-closed to 'published': a granted WRITE must never silently confer draft-read
  // ('all'). Only an explicit read grant with scope 'all' (i.e. admin) upgrades it.
  let readScope: 'published' | 'all' = 'published'
  // Hardcoded policy first, then any registry-contributed grants for this role (the opt-in seam). Extra
  // grants only ever ADD permissions for the role they were registered under — they can't revoke.
  for (const g of [...(POLICY[principal.role] ?? []), ...extraGrants]) {
    if (g.resource !== '*' && g.resource !== resource) continue
    if (g.action === action) allowed = true
    if (g.action === 'read' && (g.scope ?? 'all') === 'all') readScope = 'all' // a draft-read grant wins
  }
  // An anonymous visitor gets published read on every page-like collection (the registry-driven public
  // set), so a consumer's own pageLike collection is reachable without editing a literal allow-list.
  // Published-only and gated to the public set — never widens to drafts or non-pageLike collections.
  if (!allowed && principal.role === 'anonymous' && action === 'read' && publicResources.includes(resource)) {
    allowed = true
    readScope = 'published'
  }
  return { allowed, readScope }
}

/**
 * Whether an anonymous visitor may read a collection — i.e. whether its pages are publicly reachable.
 * The single source of truth for "what belongs in a public sitemap": a sitemap must list only URLs an
 * unauthenticated crawler can actually fetch, so the sitemap filters pageLike collections through this.
 */
export function isPubliclyReadable(resource: string, publicResources: readonly string[] = []): boolean {
  return resolveAccess({ userId: null, role: 'anonymous' }, 'read', resource, publicResources).allowed
}

/**
 * Whether a read at this `readScope` must be limited to published rows. Fail-CLOSED: only the explicit
 * `'all'` scope (admin / live preview) sees drafts; anything else — `'published'`, an unexpected value,
 * or a missing scope (a guard regression) — stays published-only. Mirrors the public render path so the
 * two read entry points can't drift to opposite defaults.
 */
export function publishedOnlyForScope(readScope: string | undefined): boolean {
  return readScope !== 'all'
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export function actionForMethod(method: string): Action {
  return SAFE_METHODS.has(method.toUpperCase()) ? 'read' : 'write'
}

/**
 * Resource for an /api path: the collection segment, except the tooling sub-routes
 * (`/options`, `/translations`, `/:id/translations`, `/:id/dead-refs`) map to a distinct
 * `<collection>/<tool>` resource so the public content grant (read on the bare collection) never covers
 * admin-only tooling — a pageLike collection's `translations` / `dead-refs` maps must NOT be readable by
 * anonymous visitors. The group-keyed and per-record translations routes share one resource: they expose
 * the same sibling ids (drafts included), so they must be gated identically.
 */
export function resourceForPath(path: string): string {
  const segs = (path.split('?')[0] ?? '').split('/').filter(Boolean)
  if (segs[0] !== 'api' || !segs[1]) return ''
  if (segs[2] === 'options' || segs[2] === 'translations') return `${segs[1]}/${segs[2]}`
  if (segs[3] === 'translations' || segs[3] === 'dead-refs') return `${segs[1]}/${segs[3]}`
  return segs[1]
}

/** Auth bootstrap endpoints, always permitted so the SPA can authenticate under default-deny. */
export function isBootstrapPath(method: string, path: string): boolean {
  const clean = path.split('?')[0]
  const m = method.toUpperCase()
  return (m === 'POST' && clean === '/api/auth/login') || (m === 'GET' && clean === '/api/auth/session')
}

/**
 * The public render entry (`GET /api/route`) the live page resolver calls. Readable by everyone — it is
 * the runtime equivalent of serving a static page — but the read SCOPE follows the principal: anonymous
 * gets published-only, an authenticated admin gets 'all' so the handler can surface a draft preview.
 * The handler itself re-forces published-only for any static-generation render (prerender / publisher).
 */
export function isPublicRenderPath(method: string, path: string): boolean {
  return method.toUpperCase() === 'GET' && path.split('?')[0] === '/api/route'
}
