import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const N = 2 ** 17
const R = 8
const P = 1
const KEYLEN = 64
const MAXMEM = 256 * 1024 * 1024

/** Hashes `password` with scrypt, returning a self-describing `scrypt$N$r$p$salt$hash` string.
 * @public
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

/** Verifies `password` against a `hashPassword` output, re-deriving with the stored parameters.
 * @public
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64url')
    expected = Buffer.from(parts[5], 'base64url')
  } catch {
    return false
  }
  if (expected.length === 0) return false

  let actual: Buffer
  try {
    actual = await scryptAsync(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM })
  } catch {
    return false
  }
  if (actual.length !== expected.length) {
    timingSafeEqual(actual, actual)
    return false
  }
  return timingSafeEqual(actual, expected)
}
