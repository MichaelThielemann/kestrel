import { describe, it, expect } from 'vitest'
import { authenticateIndex, verifyIndexAuth } from './index-auth'
import { deriveKey, randomBytes } from './crypto'
import type { GalleryIndex } from './manifest'

const sealed = (s: string) => ({ iv: 'iv', data: `enc:${s}` })
const sampleIndex = (): GalleryIndex => ({
  v: 1,
  files: [
    { blobId: '11111111-1111-1111-1111-111111111111.bin', ivB64: 'a', name: sealed('a.jpg'), mime: 'image/jpeg', size: 10 },
    { blobId: '22222222-2222-2222-2222-222222222222.bin', ivB64: 'b', name: sealed('b.jpg'), mime: 'image/png', size: 20, dir: sealed('Sub') },
  ],
  folders: [sealed('Sub')],
})

describe('index-auth — whole-index integrity tag (detects storage tampering)', () => {
  it('authenticateIndex adds a mac that verifyIndexAuth accepts (round-trip, incl. JSON re-parse)', async () => {
    const key = await deriveKey('pw', randomBytes(16))
    const authed = await authenticateIndex(sampleIndex(), key)
    expect(authed.mac).toBeTruthy()
    expect(await verifyIndexAuth(authed, key)).toBe(true)
    // survives the storage round-trip (stringify → parse), like fetching index.json back
    expect(await verifyIndexAuth(JSON.parse(JSON.stringify(authed)), key)).toBe(true)
  })

  it('rejects a REORDERED files array (a malicious backend relabelling by position)', async () => {
    const key = await deriveKey('pw', randomBytes(16))
    const authed = await authenticateIndex(sampleIndex(), key)
    const reordered = { ...authed, files: [authed.files[1]!, authed.files[0]!] }
    expect(await verifyIndexAuth(reordered, key)).toBe(false)
  })

  it('rejects a RELABELLED leaf (plaintext mime/size/blobId swapped)', async () => {
    const key = await deriveKey('pw', randomBytes(16))
    const authed = await authenticateIndex(sampleIndex(), key)
    const tampered = { ...authed, files: [{ ...authed.files[0]!, mime: 'image/evil' }, authed.files[1]!] }
    expect(await verifyIndexAuth(tampered, key)).toBe(false)
  })

  it('rejects a stripped/absent mac and a wrong key', async () => {
    const key = await deriveKey('pw', randomBytes(16))
    const other = await deriveKey('other', randomBytes(16))
    const authed = await authenticateIndex(sampleIndex(), key)
    const { mac, ...noMac } = authed
    expect(await verifyIndexAuth(noMac as GalleryIndex, key)).toBe(false)
    expect(await verifyIndexAuth(authed, other)).toBe(false)
  })

  it('the mac is key-order independent (stable canonicalization)', async () => {
    const key = await deriveKey('pw', randomBytes(16))
    const authed = await authenticateIndex(sampleIndex(), key)
    // rebuild the first file with its keys in a different order — same content, must still verify
    const f0 = authed.files[0]!
    const rekeyed = { mime: f0.mime, size: f0.size, name: f0.name, ivB64: f0.ivB64, blobId: f0.blobId }
    expect(await verifyIndexAuth({ ...authed, files: [rekeyed as typeof f0, authed.files[1]!] }, key)).toBe(true)
  })
})
