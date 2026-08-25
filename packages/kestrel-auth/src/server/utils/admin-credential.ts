import { createError } from 'h3'

type Env = Record<string, string | undefined>

/** The configured admin password hash, or `undefined` when `KESTREL_ADMIN_PASSWORD_HASH` is unset/empty. */
export function adminPasswordHash(env: Env = process.env): string | undefined {
  const stored = env.KESTREL_ADMIN_PASSWORD_HASH
  return typeof stored === 'string' && stored.length > 0 ? stored : undefined
}

let warned = false
function warnNotConfigured(): void {
  if (warned) return
  warned = true
  console.warn(
    '[kestrel auth] admin login is not configured — set KESTREL_ADMIN_PASSWORD_HASH to enable sign-in',
  )
}

/**
 * Resolve the admin password hash for a login attempt, or fail loudly when it is unset.
 *
 * A missing `KESTREL_ADMIN_PASSWORD_HASH` means login is *impossible*, not that a credential was wrong —
 * answering with the generic 401 makes an operator who simply forgot to set the hash chase a phantom
 * "wrong password". So we surface a distinct **503** (plus a one-time server warning) for that case only.
 *
 * Security: this distinguishes solely the *unconfigured* server. A configured server still answers every
 * bad credential with an opaque 401, so it never leaks which part (user/password) failed. Short-circuiting
 * here is safe — a 503 already states plainly that login is unconfigured, so there is no timing signal to
 * protect.
 */
export function requireAdminHash(env: Env = process.env, warn: () => void = warnNotConfigured): string {
  const stored = adminPasswordHash(env)
  if (!stored) {
    warn()
    throw createError({
      statusCode: 503,
      statusMessage: 'admin login is not configured (set KESTREL_ADMIN_PASSWORD_HASH)',
    })
  }
  return stored
}
