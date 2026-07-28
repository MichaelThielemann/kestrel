import { describe, it, expect } from 'vitest'
import { parseHashKey } from './share-link'

describe('parseHashKey — password from the URL fragment', () => {
  it('reads a plain #key=… fragment', () => {
    expect(parseHashKey('#key=hunter2')).toBe('hunter2')
  })
  it('finds key among other fragment params', () => {
    expect(parseHashKey('#tab=photos&key=hunter2')).toBe('hunter2')
  })
  it('does not throw on a malformed percent-sequence (a literal % in the password) — returns it raw', () => {
    expect(parseHashKey('#key=pass%word')).toBe('pass%word') // %wo is not a valid escape → keep verbatim
    expect(parseHashKey('#key=100%')).toBe('100%')
  })
  it('url-decodes the value', () => {
    expect(parseHashKey('#key=Esel%2DRose%20Sonne')).toBe('Esel-Rose Sonne')
  })
  it('tolerates a missing leading #', () => {
    expect(parseHashKey('key=x')).toBe('x')
  })
  it('returns null when there is no key', () => {
    expect(parseHashKey('')).toBeNull()
    expect(parseHashKey('#other=1')).toBeNull()
    expect(parseHashKey('#key')).toBeNull() // bare "key" with no value
  })
})
