import { safeRedirect } from './safe-redirect'

// The auth bootstrap endpoints the server always permits (login/session/logout). A 401 from these is
// not a stale session — a wrong-password login 401s — so it must not trigger a re-auth redirect. Matched
// exactly (not by `/api/auth/` prefix) so a guarded endpoint under a consumer collection named `auth`
// (e.g. `/api/auth/5`) still re-authenticates.
const BOOTSTRAP_PATHS = new Set(['/api/auth/login', '/api/auth/session', '/api/auth/logout'])

/**
 * Decide whether a failed `$fetch` should bounce the user to the login screen, and to which URL.
 *
 * Returns the login redirect target for a 401 raised by a guarded `/api/*` call made from inside the
 * admin SPA — but stays null for:
 *  - non-401 statuses and non-`/api` requests (nothing to re-authenticate);
 *  - the auth-bootstrap endpoints (`/api/auth/*`): a wrong-password login 401s and must stay put;
 *  - any location that isn't a safe admin redirect target — which also rules out the login page itself
 *    (no redirect loop) and public/SSG pages (the static site never logs in).
 */
export function reauthTarget(input: { status: number; url: string; currentPath: string }): string | null {
  if (input.status !== 401) return null
  const path = apiPath(input.url)
  if (!path.startsWith('/api/') || BOOTSTRAP_PATHS.has(path)) return null
  // The current location must itself be a valid place to return to. `safeRedirect` rejects the login
  // page and any non-admin path, so this single check guards both the loop and the public site.
  const back = safeRedirect(input.currentPath)
  if (!back) return null
  return `/admin/login?redirect=${encodeURIComponent(back)}`
}

function apiPath(url: string): string {
  // Tolerate absolute URLs (SSR/base-prefixed) and relative ones alike; fall back to the raw string.
  try { return new URL(url, 'http://localhost').pathname } catch { return url }
}

/** Minimal shape of the ofetch `onResponseError` context this interceptor reads. */
export interface ReauthContext {
  request?: string | { url?: string } | URL
  response?: { status?: number }
}

/**
 * Build an `onResponseError` handler that re-authenticates on a stale-session 401. Pure dependency
 * injection (current path / reset / navigate) keeps it unit-testable away from the Nuxt runtime; the
 * client plugin wires it to the real router, `useAuth().reset` and `navigateTo`.
 */
export function makeReauthInterceptor(deps: {
  currentPath: () => string
  reset: () => void
  navigate: (to: string) => void
}) {
  return (ctx: ReauthContext): void => {
    const target = reauthTarget({
      status: ctx.response?.status ?? 0,
      url: requestUrl(ctx.request),
      currentPath: deps.currentPath(),
    })
    if (!target) return
    deps.reset()
    deps.navigate(target)
  }
}

function requestUrl(request: ReauthContext['request']): string {
  if (typeof request === 'string') return request
  if (request instanceof URL) return request.href
  if (request && typeof request === 'object' && typeof request.url === 'string') return request.url
  return ''
}
