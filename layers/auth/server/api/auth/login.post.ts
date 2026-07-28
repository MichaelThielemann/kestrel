export default defineEventHandler(async (event) => {
  const ip = clientIp(event)
  const key = throttleKey(ip)
  const now = Date.now()
  assertBodyLimit(getRequestHeader(event, 'content-length'))
  // Reserve the attempt up front (assert-not-locked + record, atomically — no await in between) so
  // concurrent in-flight guesses from the same IP all count toward the cap before the slow hash runs.
  // The failure is already recorded here; a successful login clears it below.
  reserveLoginAttempt(key, now)
  const body = await readBody(event)
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
  let ok: boolean
  try {
    ok = await verifyPassword(password, stored)
  } finally {
    releaseHashSlot()
  }

  if (!ok) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  }
  clearLoginFailures(key)
  const exp = setAuthSession(event)
  return { ok: true, exp }
})
