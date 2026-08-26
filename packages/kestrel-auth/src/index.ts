/**
 * Kestrel's stateless single-admin session/auth domain: password hashing (scrypt), the signed session
 * cookie and its revocation epoch, login-throttling, and the `login`/`logout`/`session` pipelines.
 * Depends on `@michaelthielemann/kestrel-core` for the pipeline engine and the resolved-config seam.
 *
 * @packageDocumentation
 */

export { hashPassword, verifyPassword } from './server/utils/password.js'
export { clientIp, throttleKey } from './server/utils/client-ip.js'
export { signSession, verifySession, sessionSettings, type SessionSettings } from './server/utils/session.js'
export { refreshAuthSession } from './server/utils/session-cookie.js'
export { buildAuthPipelines } from './server/pipelines/auth.js'
export { buildSessionPipelines } from './server/pipelines/session.js'
