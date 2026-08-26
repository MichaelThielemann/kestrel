import { getCookie, getMethod, getRequestHeader, type H3Event } from 'h3'
import { clientIp, sessionSettings } from '@michaelthielemann/kestrel-auth'
import type { AccessSpec, GateEvaluators, GateOutcome, PipelineContext } from '@michaelthielemann/kestrel-core'
import { isCrossSiteWrite } from './csrf.js'
import { registeredGrants } from './grant-registry.js'
import { derivePrincipal } from './guard.js'
import { allowlistConfig, ipAllowed } from './ip-allowlist.js'
import { actionForMethod, resolveAccess, type Principal } from './policy.js'
import { isRendererContext, isStageGatePassedContext } from './render-context.js'

const ANONYMOUS: Principal = { userId: null, role: 'anonymous' }

/**
 * The principal a request runs as. Normally the access-guard middleware has already resolved it onto the
 * event; when it has not (a route outside `/api/`, a direct handler call), the session is verified here
 * from the same inputs, so the gate never depends on another handler having run first.
 * @public
 */
export function resolveEventPrincipal(event: H3Event): Principal {
  const existing = event.context.principal
  if (existing) return existing
  const settings = sessionSettings()
  return derivePrincipal({
    cookie: getCookie(event, settings.cookieName),
    secret: settings.secret,
    nowMs: Date.now(),
    isPrerender: (import.meta as { prerender?: boolean }).prerender === true || isRendererContext(),
  })
}

/** The transport plane the gates read — engine-set into `ctx.exec`, not a `RequestFacts` value (see
 *  `RequestSnapshot`). */
function requestOf(ctx: PipelineContext): { ip: string, method: string, headers: Record<string, string> } {
  return ctx.exec.request
}

/** The resource a pipeline run authorizes against: what the declaration names, else its collection, else
 *  the pipeline's own name for a collection-less one (login, logout). */
function resourceOf(spec: AccessSpec, ctx: PipelineContext): string {
  return spec.resource ?? (ctx.facts.collection || ctx.facts.op)
}

/**
 * Turn a pipeline's `access` declaration into a decision, using the same role policy the route guard uses.
 * `public: true` puts this resource into the anonymous read set (the `publicReadableResources`
 * derivation), and — for an explicitly
 * public non-read pipeline like `login` — opens the operation itself. Everything else, including which
 * registered grants apply and what read scope a principal gets, comes from `resolveAccess` (itself now
 * backed by the pure `decide` core), so a pipeline run and a guarded route can never resolve the same
 * request differently — there is exactly one access-decision engine.
 * @public
 */
export function evaluateAccessGate(spec: AccessSpec, ctx: PipelineContext): GateOutcome {
  const principal = (ctx.facts.principal as Principal | null) ?? ANONYMOUS
  const action = ctx.exec.read ? 'read' : 'write'
  const resource = resourceOf(spec, ctx)
  // Same rule (and the same `?? 'all'` default) the grant registry enforces: a public READ declaration must
  // name its scope as 'published', or an omitted scope would silently resolve to draft-read for everyone.
  if (spec.public && action === 'read' && (spec.scope ?? 'all') === 'all') {
    throw new Error(`[kestrel] pipeline "${ctx.facts.op}" declares public read access on "${resource}" without \`scope: 'published'\` — that would expose drafts to anonymous visitors`)
  }
  const publicResources = spec.public ? [resource] : []
  const { allowed, readScope } = resolveAccess(principal, action, resource, publicResources, registeredGrants()[principal.role] ?? [])
  if (allowed || spec.public) return { allowed: true, readScope, detail: `${principal.role} may ${action} ${resource}` }
  return { allowed: false, status: 401, message: 'Authentication required', detail: `${principal.role} may not ${action} ${resource}` }
}

/** The `csrf` gate: rejects a cross-site write, no-ops on a read.
 * @public
 */
export function evaluateCsrfGate(ctx: PipelineContext): GateOutcome {
  const headers = requestOf(ctx).headers
  if (actionForMethod(requestOf(ctx).method || 'POST') === 'read') return { allowed: true, detail: 'safe method' }
  if (!isCrossSiteWrite({
    secFetchSite: headers['sec-fetch-site'],
    origin: headers.origin,
    referer: headers.referer,
    host: headers.host,
  })) return { allowed: true }
  return { allowed: false, status: 403, message: 'Cross-origin write rejected' }
}

/** The `ipAllowlist` gate: enforces the stage IP allowlist against a pipeline run, exempting the renderer
 *  and admitted in-process sub-requests the same way the stage middleware does.
 * @public
 */
export function evaluateIpAllowlistGate(ctx: PipelineContext): GateOutcome {
  const { mode, cidrs } = allowlistConfig()
  if (mode !== 'enforce') return { allowed: true, detail: mode }
  // The renderer is never an external client: build-time prerender and the runtime publisher's render both
  // reach this on an in-process request that could not match a CIDR.
  if (ctx.facts.principal?.role === 'renderer') return { allowed: true, detail: 'renderer' }
  // Nitro's in-process sub-requests arrive on a mocked socket with no peer; they are recognised by the
  // async context of the external request the stage middleware already admitted (see 00.ip-allowlist.ts).
  if (isStageGatePassedContext() && !ctx.ports.event?.node?.req?.socket?.remoteAddress) return { allowed: true, detail: 'in-process sub-request' }
  if (ipAllowed(requestOf(ctx).ip, cidrs)) return { allowed: true }
  return { allowed: false, status: 403, message: 'Forbidden' }
}

/** The production evaluators — injected into every HTTP-driven pipeline run (see `pipeline-run.ts`).
 * @public
 */
export const realGateEvaluators: GateEvaluators = {
  access: evaluateAccessGate,
  csrf: evaluateCsrfGate,
  ipAllowlist: evaluateIpAllowlistGate,
}

const GATE_HEADERS = ['sec-fetch-site', 'origin', 'referer', 'host'] as const

/** The request plane the gates read: only the headers they actually consult, so nothing else leaks into a
 *  step's `env`.
 * @public
 */
export function pipelineRequestFor(event: H3Event): { ip: string, method: string, headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  for (const name of GATE_HEADERS) {
    const value = getRequestHeader(event, name)
    if (value !== undefined) headers[name] = value
  }
  return { ip: clientIp(event), method: getMethod(event), headers }
}
