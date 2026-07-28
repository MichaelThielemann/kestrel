import { describe, it, expect } from 'vitest'
import { createGallery, unlockRef, sealBlob, openBlob, fetchGalleryIndex, SALT_BYTES } from './gallery'
import { fromBase64, toBase64, randomBytes, deriveKey, makeVerifyToken, PBKDF2_ITERATIONS, LEGACY_PBKDF2_ITERATIONS } from './crypto'
import { sealToB64 } from './manifest'

const enc = new TextEncoder()
const dec = new TextDecoder()

const jsonResponse = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response

describe('secure-gallery orchestration — ref + blob seal/open (zero-knowledge)', () => {
  it('createGallery mints a namespaced, public, password-bound ref', async () => {
    const { ref, key, galleryId } = await createGallery('hunter2')
    expect(ref.v).toBe(2)
    expect(ref.galleryId).toBe(galleryId)
    expect(galleryId).toMatch(/^[0-9a-f-]{36}$/)
    expect(fromBase64(ref.saltB64)).toHaveLength(SALT_BYTES)
    expect(key).toBeInstanceOf(CryptoKey)
    expect(JSON.stringify(ref)).not.toContain('hunter2') // only a sealed verify-token, never the password
  })

  it('unlockRef re-derives the key for the right password and rejects the wrong one', async () => {
    const { ref } = await createGallery('correct horse')
    expect(await unlockRef('correct horse', ref)).toBeInstanceOf(CryptoKey)
    expect(await unlockRef('battery staple', ref)).toBeNull()
  })

  it('createGallery records the PBKDF2 iteration count in the ref (so it can be raised later)', async () => {
    const { ref } = await createGallery('pw')
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000) // OWASP 2023+ for PBKDF2-HMAC-SHA256
    expect(ref.iterations).toBe(PBKDF2_ITERATIONS)
  })

  it('unlockRef opens a LEGACY ref (no iterations) via the 310k fallback', async () => {
    // A gallery minted before the count was carried: its verify-token was derived at the legacy count and the
    // ref omits `iterations`. It must still unlock (and a wrong password must still fail).
    const salt = randomBytes(SALT_BYTES)
    const legacyKey = await deriveKey('s3cret', salt, LEGACY_PBKDF2_ITERATIONS)
    const legacyRef = { v: 2 as const, galleryId: crypto.randomUUID(), saltB64: toBase64(salt), verify: sealToB64(await makeVerifyToken(legacyKey)) }
    expect(await unlockRef('s3cret', legacyRef)).toBeInstanceOf(CryptoKey)
    expect(await unlockRef('wrong', legacyRef)).toBeNull()
  })

  it('sealBlob → openBlob round-trips bytes', async () => {
    const { key } = await createGallery('pw')
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 99])
    const { ciphertext, ivB64 } = await sealBlob(key, bytes)
    expect(typeof ivB64).toBe('string')
    expect(await openBlob(key, ivB64, ciphertext)).toEqual(bytes)
  })

  it('a blob sealed under one gallery decrypts after unlocking with the right password', async () => {
    const { ref, key } = await createGallery('s3cret')
    const { ciphertext, ivB64 } = await sealBlob(key, enc.encode('hello'))
    const reKey = await unlockRef('s3cret', ref)
    expect(reKey).not.toBeNull()
    expect(dec.decode(await openBlob(reKey!, ivB64, ciphertext))).toBe('hello')
  })

  it('openBlob throws on a wrong key (GCM auth failure) — no silent garbage', async () => {
    const { key } = await createGallery('right')
    const { ciphertext, ivB64 } = await sealBlob(key, enc.encode('secret'))
    const { key: wrongKey } = await createGallery('wrong')
    await expect(openBlob(wrongKey, ivB64, ciphertext)).rejects.toBeTruthy()
  })
})

describe('fetchGalleryIndex — all-or-nothing index load', () => {
  it('returns the parsed index on 200', async () => {
    const index = { v: 1, files: [{ blobId: 'b', ivB64: 'i', name: { iv: 'x', data: 'y' }, mime: 'image/png', size: 1 }], folders: [] }
    const got = await fetchGalleryIndex('https://cdn/ns', async () => jsonResponse(200, index))
    expect(got).toEqual(index)
  })

  it('treats a 404 (no uploads yet) as the empty index, not an error', async () => {
    const got = await fetchGalleryIndex('https://cdn/ns', async () => jsonResponse(404, null))
    expect(got).toEqual({ v: 1, files: [], folders: [] })
  })

  it('THROWS on any other non-OK status — a transient error must NOT masquerade as an empty gallery', async () => {
    // This is the load-loss guard: the widget/composable commit unlocked state only AFTER this resolves, so
    // a 500 here must reject (→ no state commit) rather than silently yield an empty model that a later
    // putIndex() would persist over the real index.
    await expect(fetchGalleryIndex('https://cdn/ns', async () => jsonResponse(500, null))).rejects.toThrow(/index 500/)
    await expect(fetchGalleryIndex('https://cdn/ns', async () => jsonResponse(503, null))).rejects.toThrow(/index 503/)
  })

  it('requests index.json under the base with no-store', async () => {
    let calledUrl = ''
    let calledInit: RequestInit | undefined
    await fetchGalleryIndex('https://cdn/ns', async (url, init) => { calledUrl = String(url); calledInit = init as RequestInit; return jsonResponse(404, null) })
    expect(calledUrl).toBe('https://cdn/ns/index.json')
    expect(calledInit?.cache).toBe('no-store')
  })
})
