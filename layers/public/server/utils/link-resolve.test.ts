import { describe, it, expect } from 'vitest'
import { isPubliclyLinkable } from './link-resolve'

describe('isPubliclyLinkable — status-gate internal link targets (no draft slug leak)', () => {
  it('rejects a missing target', () => {
    expect(isPubliclyLinkable(undefined, true)).toBe(false)
  })
  it('rejects a DRAFT/unpublished target when the collection has a status column', () => {
    expect(isPubliclyLinkable({ status: 'draft', path: '/secret' }, true)).toBe(false)
    expect(isPubliclyLinkable({ status: undefined, path: '/x' }, true)).toBe(false)
  })
  it('accepts a PUBLISHED target', () => {
    expect(isPubliclyLinkable({ status: 'published', path: '/about' }, true)).toBe(true)
  })
  it('accepts any existing target when the collection has no status column (nothing to gate)', () => {
    expect(isPubliclyLinkable({ path: '/x' }, false)).toBe(true)
    expect(isPubliclyLinkable({ status: 'draft', path: '/x' }, false)).toBe(true) // no status column → ignore the field
  })
})
