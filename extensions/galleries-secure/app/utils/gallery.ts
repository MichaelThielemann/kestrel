// The load-bearing gallery crypto orchestration, kept OUT of the Vue widgets so it unit-tests under Node.
// `createGallery`/`unlockRef` manage the password→key + the public field ref; `sealBlob`/`openBlob` handle a
// single image's ciphertext bytes. File NAMES and FOLDER paths are sealed/opened as strings by the
// index-codec (via crypto's `encryptString`/`decryptString`), NOT here — this file only does bytes + the
// password seam. The proofing extension couples only through the composable's `seal`/`open`, never here.
import { deriveKey, encryptBytes, decryptBytes, makeVerifyToken, checkPassword, randomBytes, toBase64, fromBase64, PBKDF2_ITERATIONS, LEGACY_PBKDF2_ITERATIONS } from './crypto'
import { type SecureGalleryRef, type GalleryIndex, sealToB64, sealFromB64, emptyIndex } from './manifest'

/** Per-gallery PBKDF2 salt length (bytes). One salt per gallery; a fresh IV per blob lives in the index. */
export const SALT_BYTES = 16

/** `code` on the error thrown when the index bytes arrived but are not an index. That is a PERMANENT state
 *  (a truncated/garbled write), unlike a transient fetch failure — and only it justifies offering the
 *  destructive repair, so the two must stay distinguishable to callers. */
export const INDEX_DAMAGED = 'index-damaged'

export const isIndexDamaged = (err: unknown): boolean =>
  (err as { code?: unknown } | null | undefined)?.code === INDEX_DAMAGED

/** Fetch + parse the encrypted index for a gallery from its public `base` URL. A 404 (no uploads yet) maps
 *  to the empty index; ANY other non-OK status THROWS — so a transient error can never masquerade as an
 *  empty gallery. This is load-bearing: callers commit the unlocked working model only AFTER this resolves,
 *  so a silent empty result here would let a later `putIndex()` overwrite the real index (irreversible blob
 *  orphaning). `fetchFn` is injectable for node tests; it defaults to the global `fetch`. */
export async function fetchGalleryIndex(base: string, fetchFn: typeof fetch = fetch): Promise<GalleryIndex> {
  const res = await fetchFn(`${base}/index.json`, { cache: 'no-store' })
  if (res.status === 404) return emptyIndex()
  if (!res.ok) throw new Error(`index ${res.status}`)
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (err) {
    // Only a PARSE failure says the stored bytes are not an index. A body-read/network error rejects with
    // something else and must keep its transient meaning — the caller offers a destructive rebuild for the
    // permanent case alone.
    if (!(err instanceof SyntaxError)) throw err
    parsed = undefined
  }
  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('The gallery index file is damaged.'), { code: INDEX_DAMAGED })
  }
  return parsed as GalleryIndex
}

/** Mint a brand-new gallery for `password`: a stable random `galleryId` (its storage namespace), a fresh
 *  salt, the derived key, and a sealed verify-token so a later session/viewer can confirm the password
 *  without it ever being stored. Returns the PUBLIC field ref + the in-memory key. The password is NOT
 *  recoverable. */
export async function createGallery(password: string): Promise<{ ref: SecureGalleryRef; key: CryptoKey; galleryId: string }> {
  const galleryId = crypto.randomUUID()
  const salt = randomBytes(SALT_BYTES)
  const key = await deriveKey(password, salt)
  const verify = await makeVerifyToken(key)
  return { ref: { v: 2, galleryId, saltB64: toBase64(salt), verify: sealToB64(verify), iterations: PBKDF2_ITERATIONS, authIndex: true }, key, galleryId }
}

/** Re-derive the key for an existing ref and verify `password` against its sealed verify-token. Returns the
 *  key on success, or `null` if the password is wrong — without touching the index/blobs. */
export async function unlockRef(password: string, ref: SecureGalleryRef): Promise<CryptoKey | null> {
  // Re-derive at the gallery's recorded count; galleries minted before it was carried fall back to the legacy
  // count their verify-token was derived at.
  const key = await deriveKey(password, fromBase64(ref.saltB64), ref.iterations ?? LEGACY_PBKDF2_ITERATIONS)
  return (await checkPassword(key, sealFromB64(ref.verify))) ? key : null
}

/** Encrypt one image's bytes (fresh IV). Returns the ciphertext to upload + the base64 IV to store in the
 *  index entry (the bytes are encrypted ONCE; later index re-seals never re-encrypt the blob). */
export async function sealBlob(key: CryptoKey, bytes: Uint8Array): Promise<{ ciphertext: Uint8Array; ivB64: string }> {
  const sealed = await encryptBytes(key, bytes)
  return { ciphertext: sealed.data, ivB64: toBase64(sealed.iv) }
}

/** Decrypt one image's bytes given its stored `ivB64` + the fetched ciphertext. Throws on a wrong key or
 *  tampered ciphertext (GCM auth failure). */
export async function openBlob(key: CryptoKey, ivB64: string, ciphertext: Uint8Array): Promise<Uint8Array> {
  return decryptBytes(key, { iv: fromBase64(ivB64), data: ciphertext })
}
