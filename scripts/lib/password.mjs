import { scryptSync, randomBytes } from 'node:crypto'

// Must match what layers/auth parses back out. ADR-0001 covers the parameter choice.
const N = 2 ** 17
const r = 8
const p = 1
const KEYLEN = 64
const MAXMEM = 256 * 1024 * 1024

/** `scrypt$N$r$p$salt$hash`, the `KESTREL_ADMIN_PASSWORD_HASH` format. */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function sessionSecret() {
  return randomBytes(32).toString('base64url')
}
