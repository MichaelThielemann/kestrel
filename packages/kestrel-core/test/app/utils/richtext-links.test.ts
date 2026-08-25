import { describe, it, expect } from 'vitest'
import { richtextLinkHref, parseRichtextLinkHref, collectRichtextRefs, resolveRichtextLinks } from '../../../src/app/utils/richtext-links.js'

const fakeResolve = (collection: string, id: number): string | null =>
  collection === 'pages' && id === 5 ? '/about' : collection === 'pages' && id === 6 ? '/de/x' : null

describe('richtextLinkHref', () => {
  it('builds the marker href', () => {
    expect(richtextLinkHref('pages', 5)).toBe('kestrel:pages:5')
  })
})

describe('parseRichtextLinkHref', () => {
  it('parses a marker href back to its {collection, id}', () => {
    expect(parseRichtextLinkHref('kestrel:pages:5')).toEqual({ collection: 'pages', id: 5 })
    expect(parseRichtextLinkHref('kestrel:posts:9')).toEqual({ collection: 'posts', id: 9 })
  })
  it('accepts collection names with hyphens/underscores', () => {
    expect(parseRichtextLinkHref('kestrel:blog-posts:3')).toEqual({ collection: 'blog-posts', id: 3 })
    expect(parseRichtextLinkHref('kestrel:case_studies:42')).toEqual({ collection: 'case_studies', id: 42 })
  })
  it('returns null for ordinary anchors, partial/malformed markers, and non-string input', () => {
    expect(parseRichtextLinkHref('https://x.io')).toBeNull()
    expect(parseRichtextLinkHref('/rel')).toBeNull()
    expect(parseRichtextLinkHref('kestrel:pages')).toBeNull()
    expect(parseRichtextLinkHref('kestrel:pages:')).toBeNull()
    expect(parseRichtextLinkHref('kestrel:pages:5x')).toBeNull()
    expect(parseRichtextLinkHref('')).toBeNull()
    expect(parseRichtextLinkHref(null)).toBeNull()
    expect(parseRichtextLinkHref(undefined)).toBeNull()
  })
  it('round-trips with richtextLinkHref', () => {
    expect(parseRichtextLinkHref(richtextLinkHref('pages', 7))).toEqual({ collection: 'pages', id: 7 })
  })
})

describe('collectRichtextRefs', () => {
  it('extracts every internal-link marker ref, ignoring ordinary anchors', () => {
    const html = '<p><a href="kestrel:pages:5">A</a> <a href="https://x.io">ext</a> <a href="kestrel:posts:9">B</a></p>'
    expect(collectRichtextRefs(html)).toEqual([{ collection: 'pages', id: 5 }, { collection: 'posts', id: 9 }])
  })
  it('returns [] for empty/null and for HTML without markers', () => {
    expect(collectRichtextRefs('')).toEqual([])
    expect(collectRichtextRefs(null)).toEqual([])
    expect(collectRichtextRefs('<p><a href="/x">x</a></p>')).toEqual([])
  })
})

describe('resolveRichtextLinks', () => {
  it('rewrites a marker href to the resolved localized path', () => {
    expect(resolveRichtextLinks('<a href="kestrel:pages:5">About</a>', fakeResolve)).toBe('<a href="/about">About</a>')
    expect(resolveRichtextLinks('<a href="kestrel:pages:6">X</a>', fakeResolve)).toBe('<a href="/de/x">X</a>')
  })
  it('rewrites an unresolved (dangling/missing-target) marker to "#"', () => {
    expect(resolveRichtextLinks('<a href="kestrel:posts:99">gone</a>', fakeResolve)).toBe('<a href="#">gone</a>')
  })
  it('leaves ordinary anchors and non-string input untouched', () => {
    expect(resolveRichtextLinks('<a href="https://x.io">x</a><a href="/rel">y</a>', fakeResolve)).toBe('<a href="https://x.io">x</a><a href="/rel">y</a>')
    expect(resolveRichtextLinks('', fakeResolve)).toBe('')
    expect(resolveRichtextLinks(null, fakeResolve)).toBe('')
  })
  it('escapes quotes/ampersands in a resolved path (attribute-safe)', () => {
    const out = resolveRichtextLinks('<a href="kestrel:pages:5">x</a>', () => '/a?b=1&c="d"')
    expect(out).toBe('<a href="/a?b=1&amp;c=&quot;d&quot;">x</a>')
  })
})
