// Zero-knowledge crypto for the secure gallery. Runs in the BROWSER — the editor encrypts before upload,
// the viewer decrypts after fetch; the SERVER never sees the password or any plaintext. Isomorphic
// WebCrypto (`crypto.subtle`), so it also unit-tests under Node. AES-256-GCM (authenticated) with a
// per-gallery PBKDF2-SHA256-derived key; a fresh random IV per item (never reuse IV+key with GCM).

const enc = new TextEncoder()
const dec = new TextDecoder()

/** PBKDF2 work factor (SHA-256) for NEW galleries — OWASP's 2023+ guidance for PBKDF2-HMAC-SHA256. The count
 *  is recorded in each gallery's ref so it can be raised over time without breaking existing galleries. */
export const PBKDF2_ITERATIONS = 600_000
/** The work factor used before the count was carried in the ref — the fallback when `ref.iterations` is absent
 *  (those galleries' verify-tokens were derived at this count, so they must be re-derived at it to unlock). */
export const LEGACY_PBKDF2_ITERATIONS = 310_000
// Sealed under the key so a viewer/editor can confirm the password WITHOUT it ever being stored/sent. This
// value is baked into every manifest's verify-token at creation, so it MUST stay stable across package
// renames — it is therefore deliberately NAME-INDEPENDENT (do NOT sweep it in a rename). `checkPassword`
// also accepts the historical sentinels so galleries created under earlier names still open.
const VERIFY_PLAINTEXT = 'kestrel:gallery-verify:v1'
const VERIFY_ACCEPTED = new Set([VERIFY_PLAINTEXT, 'kestrel-secure-gallery:v1', 'kestrel-galleries-secure:v1'])

/** A ciphertext blob + the random IV it was sealed with. The IV is public (stored next to the data). */
export interface Sealed {
  iv: Uint8Array
  data: Uint8Array
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** SHA-256 digest of `bytes` (used to authenticate the whole index in one tag). */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** Derive the AES-GCM key from a password + a per-gallery salt. Non-extractable. `iterations` defaults to the
 *  current work factor for new galleries; callers pass an existing gallery's recorded count to re-derive it. */
export async function deriveKey(password: string, salt: Uint8Array, iterations: number = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  // Unicode-normalize (NFC) before deriving: the SAME visual password can arrive as different byte
  // sequences from different keyboards/OSes/IMEs (e.g. "é" as U+00E9 vs U+0065 U+0301), which would
  // otherwise derive different keys and lock a customer out on another device. NFC is the RFC 8265
  // OpaqueString profile's normalization for passwords; ASCII passwords are unaffected (no-op).
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    // `as BufferSource`: the bytes are ArrayBuffer-backed at runtime; TS 6's `Uint8Array<ArrayBufferLike>`
    // default is wider than WebCrypto's `BufferSource` accepts.
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// Optional `aad` (AES-GCM additionalData): authenticated-but-not-encrypted bytes bound into the tag. The same
// `aad` MUST be supplied to decrypt, so it ties a ciphertext to a context (e.g. a proofing submission to its
// gallerySlug|customerId) — a relabel/replay under a different context fails the auth check.
function gcmParams(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  const p: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource }
  if (aad) p.additionalData = aad as BufferSource
  return p
}

export async function encryptBytes(key: CryptoKey, bytes: Uint8Array, aad?: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(12)
  const data = new Uint8Array(await crypto.subtle.encrypt(gcmParams(iv, aad), key, bytes as BufferSource))
  return { iv, data }
}

/** Decrypt; throws (GCM auth-tag failure) on a wrong key, tampered ciphertext, or mismatched `aad`. */
export async function decryptBytes(key: CryptoKey, sealed: Sealed, aad?: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt(gcmParams(sealed.iv, aad), key, sealed.data as BufferSource))
}

export async function encryptString(key: CryptoKey, text: string): Promise<Sealed> {
  return encryptBytes(key, enc.encode(text))
}
export async function decryptString(key: CryptoKey, sealed: Sealed): Promise<string> {
  return dec.decode(await decryptBytes(key, sealed))
}

/** Seal a known constant so re-editing / viewing can verify the password is correct, without storing it. */
export async function makeVerifyToken(key: CryptoKey): Promise<Sealed> {
  return encryptString(key, VERIFY_PLAINTEXT)
}
export async function checkPassword(key: CryptoKey, token: Sealed): Promise<boolean> {
  try {
    return VERIFY_ACCEPTED.has(await decryptString(key, token))
  } catch {
    return false // wrong key → GCM auth fails → not the password
  }
}

// Base64 for storing binary (IV + small sealed strings) inside the JSON manifest. Image ciphertext goes to
// storage as a raw blob, not base64.
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const a = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i)
  return a
}
