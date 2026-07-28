import { describe, it, expect } from 'vitest'
import { sanitizeRichtext } from './sanitize'

describe('sanitizeRichtext', () => {
  it('keeps allowed markup', () => {
    expect(sanitizeRichtext('<p>Hello <strong>world</strong></p>')).toBe('<p>Hello <strong>world</strong></p>')
  })
  it('drops <script>', () => {
    expect(sanitizeRichtext('<script>alert(1)</script><p>ok</p>')).toBe('<p>ok</p>')
  })
  it('neutralises img onerror but keeps the img', () => {
    const out = sanitizeRichtext('<img src="x" onerror="alert(1)">')
    expect(out).toContain('<img')
    expect(out).not.toContain('onerror')
  })
  it('drops javascript: hrefs', () => {
    expect(sanitizeRichtext('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
  })
  it('forces rel/target on external (absolute http(s)) links', () => {
    const out = sanitizeRichtext('<a href="https://e.com">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
  })
  it('does NOT force target/rel on internal/relative links', () => {
    const out = sanitizeRichtext('<a href="/about">x</a>')
    expect(out).toContain('href="/about"')
    expect(out).not.toContain('target=')
    expect(out).not.toContain('nofollow')
  })
  it('keeps the internal-link marker scheme (kestrel:) and does not externalise it', () => {
    const out = sanitizeRichtext('<a href="kestrel:pages:5">About</a>')
    expect(out).toContain('href="kestrel:pages:5"')
    expect(out).not.toContain('target=')
    expect(out).not.toContain('nofollow')
  })
  it('strips an author-supplied target=_blank/nofollow from an internal link', () => {
    const out = sanitizeRichtext('<a href="/x" target="_blank" rel="nofollow">x</a>')
    expect(out).not.toContain('target=')
    expect(out).not.toContain('nofollow')
  })
  it('preserves a span class round-trip (editor↔sanitize alignment)', () => {
    // The richtext editor now keeps `class` on spans (richtext-preserve-class.ts); sanitize must not
    // strip it, or the class would still vanish on save.
    const out = sanitizeRichtext('<h1><span class="text--color-white text--hero-headline-1">X</span></h1>')
    expect(out).toContain('class="text--color-white text--hero-headline-1"')
  })
  it('preserves a block-level class round-trip', () => {
    const out = sanitizeRichtext('<p class="text--section-label">L</p>')
    expect(out).toContain('class="text--section-label"')
  })
  it('keeps <mark> (highlight)', () => {
    expect(sanitizeRichtext('<p><mark>hi</mark></p>')).toBe('<p><mark>hi</mark></p>')
  })
  it('keeps text-align styles', () => {
    expect(sanitizeRichtext('<p style="text-align:center">x</p>')).toContain('text-align:center')
    expect(sanitizeRichtext('<p style="text-align:justify">x</p>')).toContain('text-align:justify')
  })
  it('strips non-text-align style properties but keeps text-align', () => {
    const out = sanitizeRichtext('<p style="text-align:center;background:red">x</p>')
    expect(out).toContain('text-align:center')
    expect(out).not.toContain('background')
  })
  it('drops a style with no allowed properties (no CSS injection surface)', () => {
    const out = sanitizeRichtext('<p style="background:url(javascript:alert(1))">x</p>')
    expect(out).not.toContain('javascript')
    expect(out).not.toContain('background')
    expect(out).not.toContain('style=')
  })
  it('rejects a non-whitelisted text-align value', () => {
    expect(sanitizeRichtext('<p style="text-align:expression(alert(1))">x</p>')).not.toContain('expression')
  })
})
