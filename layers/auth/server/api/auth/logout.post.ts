export default defineEventHandler((event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  // Clear the cookie for THIS client AND bump the revocation epoch so any other copy of the token (a synced
  // backup, a leaked log, another device) is invalidated server-side immediately — a real logout, not just a
  // cookie clear. Single admin ⇒ logout = logout-everywhere, which is the expected behaviour.
  clearAuthSession(event)
  bumpSessionEpoch()
  return { ok: true }
})
