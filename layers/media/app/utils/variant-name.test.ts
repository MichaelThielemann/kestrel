import { describe, it, expect } from 'vitest'
import { variantName } from './variant-name'

describe('variantName', () => {
  it('names a proportional (width-only) spec w<width>', () => {
    expect(variantName({ width: 320 })).toBe('w320')
    expect(variantName({ width: 1280, height: null })).toBe('w1280')
  })

  it('names a fixed-box crop c<w>x<h>, appending the fit only when it is not the default cover', () => {
    expect(variantName({ width: 320, height: 320 })).toBe('c320x320')
    expect(variantName({ width: 320, height: 320, fit: 'cover' })).toBe('c320x320')
    expect(variantName({ width: 400, height: 300, fit: 'contain' })).toBe('c400x300-contain')
  })
})
