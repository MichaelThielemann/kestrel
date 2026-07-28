import { describe, it, expect } from 'vitest'
import { GALLERY_ID_RE, BLOB_ID_RE } from './namespace'

describe('gallery id / blob structural validation (shared constants)', () => {
  it('GALLERY_ID_RE accepts a real randomUUID + canonical UUID, rejects loose 36-char garbage', () => {
    expect(GALLERY_ID_RE.test(crypto.randomUUID())).toBe(true)
    expect(GALLERY_ID_RE.test('11111111-1111-1111-1111-111111111111')).toBe(true)
    expect(GALLERY_ID_RE.test('------------------------------------')).toBe(false)
    expect(GALLERY_ID_RE.test('0000000000000000000000000000000000aa')).toBe(false)
    expect(GALLERY_ID_RE.test('abc')).toBe(false)
  })

  it('BLOB_ID_RE requires a <uuid>.bin filename (no slashes / traversal)', () => {
    expect(BLOB_ID_RE.test(`${crypto.randomUUID()}.bin`)).toBe(true)
    expect(BLOB_ID_RE.test(crypto.randomUUID())).toBe(false)
    expect(BLOB_ID_RE.test('../11111111-1111-1111-1111-111111111111.bin')).toBe(false)
  })
})
