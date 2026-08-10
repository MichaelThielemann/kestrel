import { describe, it, expect } from 'vitest'
import { composeTitle, siteHeadFallbacks } from './site-head'

describe('composeTitle', () => {
  it('appends the base title with the configured separator', () => {
    expect(composeTitle('About', { baseTitle: 'Acme', titleSeparator: '|', titlePosition: 'after' }))
      .toBe('About | Acme')
  })

  it('prepends it when the position says so', () => {
    expect(composeTitle('About', { baseTitle: 'Acme', titleSeparator: '—', titlePosition: 'before' }))
      .toBe('Acme — About')
  })

  it('pads the stored token, and defaults it, rather than gluing the two titles together', () => {
    // A `text` field trims on write, so the stored value can never carry its own spaces — verified against
    // a real write, which turned " | " into "|".
    expect(composeTitle('About', { baseTitle: 'Acme' })).toBe('About | Acme')
    expect(composeTitle('About', { baseTitle: 'Acme', titleSeparator: '·' })).toBe('About · Acme')
    expect(composeTitle('About', { baseTitle: 'Acme', titleSeparator: '   ' })).toBe('About | Acme')
  })

  it('returns the page title untouched when no base title is set', () => {
    for (const site of [null, undefined, {}, { baseTitle: '' }, { baseTitle: '   ' }]) {
      expect(composeTitle('About', site as never)).toBe('About')
    }
  })

  it('uses the base title alone when the page has no title', () => {
    // The site root before a home page is published renders with no title; emitting a lone separator
    // (" | Acme") would be worse than the site name on its own.
    expect(composeTitle('', { baseTitle: 'Acme' })).toBe('Acme')
    expect(composeTitle(undefined, { baseTitle: 'Acme' })).toBe('Acme')
  })

  it('returns undefined when there is nothing to build a title from', () => {
    expect(composeTitle(undefined, null)).toBeUndefined()
    expect(composeTitle('', {})).toBeUndefined()
  })

  it('does not double up when the page title already ends in the base title', () => {
    // Migrated content often carries the site name in the page title already; appending it again reads
    // as a bug to everyone who sees the tab.
    expect(composeTitle('About | Acme', { baseTitle: 'Acme' })).toBe('About | Acme')
    expect(composeTitle('Acme', { baseTitle: 'Acme' })).toBe('Acme')
  })
})

describe('siteHeadFallbacks', () => {
  const site = { description: 'Site wide', $media: { image: { src: '/s.png', width: 8, height: 4 } } }

  it('prefers the page values', () => {
    const out = siteHeadFallbacks(
      { description: 'Page own', $media: { image: { src: '/p.png', width: 2, height: 1 } } },
      site,
    )
    expect(out.description).toBe('Page own')
    expect(out.image).toEqual({ src: '/p.png', width: 2, height: 1 })
  })

  it('falls back to the site values when the page has none', () => {
    const out = siteHeadFallbacks({}, site)
    expect(out.description).toBe('Site wide')
    expect(out.image).toEqual({ src: '/s.png', width: 8, height: 4 })
  })

  it('treats an empty string and a null image as absent', () => {
    const out = siteHeadFallbacks({ description: '', $media: { image: null } }, site)
    expect(out.description).toBe('Site wide')
    expect(out.image).toEqual({ src: '/s.png', width: 8, height: 4 })
  })

  it('emits nothing when neither side has a value, so the tags degrade away', () => {
    const out = siteHeadFallbacks({}, null)
    expect(out.description).toBeUndefined()
    expect(out.image).toBeNull()
  })
})
