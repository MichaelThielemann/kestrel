import { describe, it, expect } from 'vitest'
import { rgbaToThumbHash } from 'thumbhash'
import { thumbhashToDataUrl } from './thumbhash'

// A real thumbhash (base64), exactly as the server stores it (derive.ts).
function makeThumbhash(): string {
  const w = 4, h = 4
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 120; rgba[i * 4 + 1] = 160; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255 }
  let bin = ''
  for (const b of rgbaToThumbHash(w, h, rgba)) bin += String.fromCharCode(b)
  return btoa(bin)
}

describe('thumbhashToDataUrl', () => {
  it('decodes a stored base64 thumbhash to a PNG data URL', () => {
    const url = thumbhashToDataUrl(makeThumbhash())
    expect(url).toMatch(/^data:image\/png/)
  })
  it('returns null for an absent thumbhash (null/undefined/empty)', () => {
    expect(thumbhashToDataUrl(null)).toBeNull()
    expect(thumbhashToDataUrl(undefined)).toBeNull()
    expect(thumbhashToDataUrl('')).toBeNull()
  })
  it('returns null (never throws) for malformed input', () => {
    expect(thumbhashToDataUrl('not valid base64 !!!')).toBeNull()
  })
})
