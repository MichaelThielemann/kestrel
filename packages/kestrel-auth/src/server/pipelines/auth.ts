import { getRequestHeader, readBody } from 'h3'
import { Effect } from 'effect'
import { Unauthorized } from '@michaelthielemann/kestrel-contracts'
import { assertBodyLimit, definePipeline, eventOf } from '@michaelthielemann/kestrel-core'
import type { PipelineDef, StepDef } from '@michaelthielemann/kestrel-core'
import { requireAdminHash } from '../utils/admin-credential.js'
import { clientIp, throttleKey } from '../utils/client-ip.js'
import {
  acquireHashSlot, clearLoginFailures, MAX_LOGIN_BODY, releaseHashSlot,
  releaseLoginAttempt, reserveLoginAttempt,
} from '../utils/login-throttle.js'
import { verifyPassword } from '../utils/password.js'
import { clearAuthSession, setAuthSession } from '../utils/session-cookie.js'
import { bumpSessionEpoch } from '../utils/session-epoch.js'
import { buildSessionPipelines } from './session.js'

const verifyCredentials: StepDef = {
  name: 'verifyCredentials',
  fn: (ctx) => Effect.gen(function* () {
    const event = eventOf(ctx)
    const key = throttleKey(clientIp(event))
    const now = Date.parse(ctx.facts.now)
    assertBodyLimit(getRequestHeader(event, 'content-length'), MAX_LOGIN_BODY)
    // Reserve the attempt up front (assert-not-locked + record, atomically — no await in between) so
    // concurrent in-flight guesses from the same IP all count toward the cap before the slow hash runs.
    // The failure is already recorded here; a successful login clears it below.
    reserveLoginAttempt(key, now)
    const body = yield* Effect.promise(() => readBody(event))
    const password = typeof body?.password === 'string' ? body.password : ''

    let stored: string
    try {
      // No hash configured → login is impossible: surface a distinct 503 instead of a confusing 401.
      stored = requireAdminHash()
    } catch (error) {
      // A server-side misconfiguration nobody can guess their way past: refund the reservation so the admin
      // isn't still locked out once they set the hash. The slot-busy 503 below stays billable by contrast —
      // it IS attacker-triggerable, and charging it is what makes a flood run into the lockout.
      releaseLoginAttempt(key, now)
      throw error
    }
    acquireHashSlot()
    // A plain JS try/finally does not observe an Effect failure crossing a `yield*` (only Effect's own
    // combinators do) — Effect.ensuring is the real finally: it runs the slot release on success, failure,
    // AND interruption alike.
    const ok = yield* Effect.promise(() => verifyPassword(password, stored)).pipe(
      Effect.ensuring(Effect.sync(() => releaseHashSlot())),
    )

    if (!ok) return yield* Effect.fail(new Unauthorized({ reason: 'Invalid credentials' }))
    ctx.work.throttleKey = key
  }),
}

const issueSession: StepDef = {
  name: 'issueSession',
  fn: (ctx) => Effect.sync(() => {
    clearLoginFailures(ctx.work.throttleKey as string)
    ctx.output = { ok: true, exp: setAuthSession(eventOf(ctx)) }
  }),
}

const clearSession: StepDef = {
  name: 'clearSession',
  fn: (ctx) => Effect.sync(() => {
    // Clear the cookie for THIS client AND bump the revocation epoch so any other copy of the token (a synced
    // backup, a leaked log, another device) is invalidated server-side immediately — a real logout, not just a
    // cookie clear. Single admin ⇒ logout = logout-everywhere, which is the expected behaviour.
    clearAuthSession(eventOf(ctx))
    bumpSessionEpoch()
    ctx.output = { ok: true }
  }),
}

/** `login` is the one public write: nobody can hold a session before they have one. The CSRF gate still
 *  applies (default for a non-read op), which is what keeps a cross-origin page from logging a visitor in.
 *  `logout` is an ordinary admin write.
 * @public
 */
export function buildAuthPipelines(): PipelineDef[] {
  return [
    // rawBody: the router must not buffer the body before verifyCredentials' assertBodyLimit ran —
    // login is public, so a pre-step readBody would buffer attacker-sized bodies with no ceiling.
    definePipeline({ name: 'login', access: { public: true }, rawBody: true, steps: [verifyCredentials, issueSession] }),
    definePipeline({ name: 'logout', access: { role: 'admin' }, steps: [clearSession] }),
    ...buildSessionPipelines(),
  ]
}
