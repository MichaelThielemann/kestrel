import { verifySession } from '@michaelthielemann/kestrel-auth'
import type { Principal } from './policy.js'

/** The inputs `derivePrincipal` needs to resolve a request's principal.
 * @public
 */
export interface PrincipalInput {
  cookie: string | undefined
  secret: string
  nowMs: number
  isPrerender: boolean
}

/**
 * Who a request runs as. The build-time prerender and the runtime publisher's render arrive as `renderer`
 * (an in-process signal, not a forgeable header); a valid session cookie is the admin; everything else is
 * anonymous. What that principal may then DO is decided by the pipeline's own access gate.
 * @public
 */
export function derivePrincipal(input: PrincipalInput): Principal {
  if (input.isPrerender) return { userId: 'renderer', role: 'renderer' }
  if (verifySession(input.secret, input.cookie, input.nowMs).valid) return { userId: 'admin', role: 'admin' }
  return { userId: null, role: 'anonymous' }
}
