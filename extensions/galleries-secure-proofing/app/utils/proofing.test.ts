import { describe, it, expect } from 'vitest'
import { emptyDoc, setMark, validateDoc, PROOFING_COLORS, proofingAad, sealedTooLarge, MAX_SEALED_B64 } from './proofing'

describe('proofingAad — binds a submission to its (gallerySlug, customerId)', () => {
  const dec = new TextDecoder()
  it('is deterministic for the same inputs', () => {
    expect(proofingAad('g', 'c')).toEqual(proofingAad('g', 'c'))
  })
  it('differs by customer and by gallery (no ambiguous concatenation)', () => {
    const k = (a: Uint8Array) => dec.decode(a)
    expect(k(proofingAad('g', 'a'))).not.toBe(k(proofingAad('g', 'b')))
    expect(k(proofingAad('g1', 'c'))).not.toBe(k(proofingAad('g2', 'c')))
    // a separator that can't be forged across the boundary: "ab|c" must not collide with "a|bc"
    expect(k(proofingAad('ab', 'c'))).not.toBe(k(proofingAad('a', 'bc')))
  })
})

describe('proofing marks model', () => {
  it('emptyDoc has no marks', () => {
    expect(emptyDoc()).toEqual({ marks: {} })
  })

  it('setMark sets a colour + comment immutably', () => {
    const a = emptyDoc()
    const b = setMark(a, 'k1', { color: 'green', comment: 'love this one' })
    expect(a).toEqual({ marks: {} }) // unchanged
    expect(b.marks.k1).toEqual({ color: 'green', comment: 'love this one' })
  })

  it('setMark caps an overlong comment at MAX_COMMENT so an oversized doc can never be authored', () => {
    const b = setMark(emptyDoc(), 'k1', { comment: 'x'.repeat(5000) })
    expect(b.marks.k1.comment).toHaveLength(2000)
  })

  it('setMark with an empty mark removes the entry', () => {
    const doc = setMark(emptyDoc(), 'k1', { color: 'red' })
    expect(setMark(doc, 'k1', {}).marks).toEqual({})
    expect(setMark(doc, 'k1', { color: '', comment: '' }).marks).toEqual({})
  })

  it('validateDoc keeps valid marks, drops malformed ones, caps the comment', () => {
    const dirty = {
      marks: {
        ok: { color: 'blue', comment: 'nice' },
        junk: 'not-an-object',
        partial: { color: 123, comment: 'x'.repeat(5000) }, // bad colour dropped, comment capped
        empty: {},
      },
    }
    const clean = validateDoc(dirty)!
    expect(clean.marks.ok).toEqual({ color: 'blue', comment: 'nice' })
    expect(clean.marks.junk).toBeUndefined()
    expect(clean.marks.empty).toBeUndefined()
    expect(clean.marks.partial.color).toBeUndefined()
    expect(clean.marks.partial.comment).toHaveLength(2000)
  })

  it('validateDoc rejects a non-object / missing marks', () => {
    expect(validateDoc(null)).toBeNull()
    expect(validateDoc({})).toBeNull()
    expect(validateDoc({ marks: 'nope' })).toBeNull()
  })

  it('exposes a colour palette', () => {
    expect(PROOFING_COLORS).toContain('green')
    expect(PROOFING_COLORS.length).toBeGreaterThanOrEqual(3)
  })
})

describe('sealedTooLarge — mirrors the server MAX_SEALED_B64 cap so the client can refuse before a request', () => {
  it('is false at/under the cap and true just past it', () => {
    expect(sealedTooLarge({ iv: 'a', data: 'x'.repeat(MAX_SEALED_B64 - 1) })).toBe(false)
    expect(sealedTooLarge({ iv: 'a', data: 'x'.repeat(MAX_SEALED_B64) })).toBe(true)
  })
})
