import { describe, it, expect } from 'vitest'
import { sanitizeRichtext } from './sanitize'

describe('sanitizeRichtext', () => {
  it('keeps allowed markup', () => {
    expect(sanitizeRichtext('<p>Hello <strong>world</strong></p>')).toBe('<p>Hello <strong>world</strong></p>')
  })
  it('drops <script>', () => {
    expect(sanitizeRichtext('<script>alert(1)</script><p>ok</p>')).toBe('<p>ok</p>')
  })
  // Flow text holds no images — they belong in a media field or an image block, and the editor's schema
  // cannot parse one, so allowing it here would only mean the first edit deletes it.
  it('drops an img entirely, script handler and all', () => {
    expect(sanitizeRichtext('<img src="x" onerror="alert(1)">')).toBe('')
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

// The dialect the server STORES, construct by construct. It is not the editor's: sanitize-html
// self-closes void elements, decodes `&nbsp;` and drops the space inside a style value, where TipTap's
// serializer does none of those. Editing such a field therefore leaves the form "unsaved" until it is
// written once, even when nothing changed — accepted, see docs/dev/ACCEPTED-DECISIONS.md (AD-7). This
// table exists so a shift in that dialect surfaces as a named row rather than as a phantom lamp.
describe('sanitizeRichtext — the stored dialect', () => {
  const NBSP = '\u00A0' // written as an escape: a raw U+00A0 in source is invisible in a diff
  const corpus: [name: string, input: string, stored: string][] = [
    ['plain paragraph', '<p>a b</p>', '<p>a b</p>'],
    ['hard break', '<p>a<br>b</p>', '<p>a<br />b</p>'],
    ['horizontal rule', '<hr>', '<hr />'],
    ['non-breaking space', '<p>a&nbsp;b</p>', `<p>a${NBSP}b</p>`],
    ['alignment', '<p style="text-align: center">c</p>', '<p style="text-align:center">c</p>'],
    ['marks', '<p><strong>a</strong><em>b</em><mark>c</mark></p>', '<p><strong>a</strong><em>b</em><mark>c</mark></p>'],
    ['heading', '<h2>t</h2>', '<h2>t</h2>'],
    ['span class', '<p><span class="c">x</span></p>', '<p><span class="c">x</span></p>'],
    ['nested list', '<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>', '<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>'],
    ['blockquote', '<blockquote><p>q</p></blockquote>', '<blockquote><p>q</p></blockquote>'],
    ['code block', '<pre><code>c</code></pre>', '<pre><code>c</code></pre>'],
    ['relative link', '<p><a href="/impressum">l</a></p>', '<p><a href="/impressum">l</a></p>'],
    ['mailto link', '<p><a href="mailto:a@b.c">l</a></p>', '<p><a href="mailto:a@b.c">l</a></p>'],
    ['internal link', '<p><a href="kestrel:pages:7">l</a></p>', '<p><a href="kestrel:pages:7">l</a></p>'],
    ['external link', '<p><a href="https://e.com/x">l</a></p>', '<p><a href="https://e.com/x" target="_blank" rel="noopener noreferrer nofollow">l</a></p>'],
    ['image', '<p>t</p><figure><img src="/x.jpg" alt="a"><figcaption>c</figcaption></figure>', '<p>t</p>c'],
    ['table', '<table><tbody><tr><td>z</td></tr></tbody></table>', 'z'],
  ]

  it.each(corpus)('%s', (_name, input, stored) => {
    expect(sanitizeRichtext(input)).toBe(stored)
  })

  it('stores a fixed point in every case', () => {
    for (const [name, , stored] of corpus) expect([name, sanitizeRichtext(stored)]).toEqual([name, stored])
  })
})
