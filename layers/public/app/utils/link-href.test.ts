import { describe, it, expect } from 'vitest'
import { linkToHref, linkLabel } from './link-href'

describe('linkToHref', () => {
  it('maps each scheme to an href', () => {
    expect(linkToHref({ type: 'external', url: 'https://x.io' })).toBe('https://x.io')
    expect(linkToHref({ type: 'email', email: 'a@b.io' })).toBe('mailto:a@b.io')
    expect(linkToHref({ type: 'tel', tel: '+49123' })).toBe('tel:+49123')
  })

  it('reads the populated href for an internal link, falling back to # when unresolved', () => {
    expect(linkToHref({ type: 'internal', collection: 'pages', id: 5, href: '/de/about' })).toBe('/de/about')
    expect(linkToHref({ type: 'internal', collection: 'pages', id: 5 })).toBe('#')
  })

  it('appends an internal link hash to the resolved path, but never to an unresolved #', () => {
    expect(linkToHref({ type: 'internal', collection: 'pages', id: 5, href: '/', hash: 'about' })).toBe('/#about')
    expect(linkToHref({ type: 'internal', collection: 'pages', id: 5, href: '/history', hash: 'csc23' })).toBe('/history#csc23')
    // unresolved target stays '#' — the hash must not fabricate a fragment-only link
    expect(linkToHref({ type: 'internal', collection: 'pages', id: 5, hash: 'about' })).toBe('#')
  })

  it('returns empty for a null/absent value', () => {
    expect(linkToHref(null)).toBe('')
    expect(linkToHref(undefined)).toBe('')
  })
})

describe('linkLabel', () => {
  it('prefers the explicit label, else a scheme-appropriate default', () => {
    expect(linkLabel({ type: 'external', url: 'https://x.io', label: 'Home' })).toBe('Home')
    expect(linkLabel({ type: 'external', url: 'https://x.io' })).toBe('https://x.io')
    expect(linkLabel({ type: 'email', email: 'a@b.io' })).toBe('a@b.io')
    expect(linkLabel({ type: 'tel', tel: '+49' })).toBe('+49')
    expect(linkLabel(null)).toBe('')
  })
})
