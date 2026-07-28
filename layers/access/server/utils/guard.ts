import { isCrossSiteWrite, type CsrfHeaders } from './csrf'
import { verifySession } from '../../../auth/server/utils/session'
import { resolveAccess, actionForMethod, resourceForPath, isBootstrapPath, isPublicRenderPath, type Principal, type Grant, type Role } from './policy'

export interface AccessInput {
  method: string
  path: string
  csrf: CsrfHeaders
  cookie: string | undefined
  secret: string
  nowMs: number
  isPrerender: boolean
}

export type AccessDecision =
  | { allow: true; principal: Principal; readScope: 'published' | 'all' }
  | { allow: false; status: number; message: string }

export function derivePrincipal(input: AccessInput): Principal {
  if (input.isPrerender) return { userId: 'renderer', role: 'renderer' }
  if (verifySession(input.secret, input.cookie, input.nowMs).valid) return { userId: 'admin', role: 'admin' }
  return { userId: null, role: 'anonymous' }
}

export function evaluateAccess(input: AccessInput, publicResources: readonly string[] = [], registeredGrants: Readonly<Partial<Record<Role, Grant[]>>> = {}): AccessDecision {
  // CSRF first: every unsafe method (incl. login) must be same-site.
  if (actionForMethod(input.method) === 'write' && isCrossSiteWrite(input.csrf)) {
    return { allow: false, status: 403, message: 'Cross-origin write rejected' }
  }
  const principal = derivePrincipal(input)
  // Auth bootstrap (login/session) is always permitted so the SPA can authenticate. Scope still follows
  // the principal (mirrors isPublicRenderPath below) — an anonymous caller never gets draft-read scope.
  if (isBootstrapPath(input.method, input.path)) {
    return { allow: true, principal, readScope: principal.role === 'anonymous' ? 'published' : 'all' }
  }
  // The public render entry is readable by everyone; the scope follows the principal so an admin can
  // preview drafts while anonymous (and the static render) stay published-only.
  if (isPublicRenderPath(input.method, input.path)) {
    return { allow: true, principal, readScope: principal.role === 'anonymous' ? 'published' : 'all' }
  }
  const { allowed, readScope } = resolveAccess(principal, actionForMethod(input.method), resourceForPath(input.path), publicResources, registeredGrants[principal.role] ?? [])
  if (!allowed) return { allow: false, status: 401, message: 'Authentication required' }
  return { allow: true, principal, readScope }
}
