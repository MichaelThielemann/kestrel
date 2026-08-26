import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Schema } from 'effect'
import { SanitizedRichtext } from '@michaelthielemann/kestrel-contracts'
import { sanitizeRichtext } from '../../../src/server/core/sanitize.js'

const isValidSanitized = Schema.is(SanitizedRichtext)

describe('sanitizeRichtext — output always satisfies the brand\'s schema', () => {
  it('every output decodes as SanitizedRichtext', () => {
    fc.assert(fc.property(fc.string(), (html) => {
      expect(isValidSanitized(sanitizeRichtext(html))).toBe(true)
    }))
  })

  it('is idempotent: sanitizing already-sanitized output changes nothing further', () => {
    fc.assert(fc.property(fc.string(), (html) => {
      const once = sanitizeRichtext(html)
      expect(sanitizeRichtext(once)).toBe(once)
    }))
  })
})

describe('sanitizeRichtext — dangerous input never survives', () => {
  it('script tags are always stripped, verbatim script content included', () => {
    fc.assert(fc.property(fc.string(), (payload) => {
      const out = sanitizeRichtext(`<script>${payload}</script>`)
      expect(out).not.toContain('<script')
      expect(out).not.toContain('</script>')
    }))
  })

  it('inline event handlers never survive on any allowed tag', () => {
    fc.assert(fc.property(fc.string(), (payload) => {
      const out = sanitizeRichtext(`<p onclick="${payload}">x</p>`)
      expect(out).not.toMatch(/onclick/i)
    }))
  })

  it('javascript: URLs never survive as a link href', () => {
    fc.assert(fc.property(fc.string(), (payload) => {
      const out = sanitizeRichtext(`<a href="javascript:${payload}">x</a>`)
      expect(out).not.toMatch(/javascript:/i)
    }))
  })

  it('an absolute http(s) link always gets target=_blank + a noopener/noreferrer/nofollow rel', () => {
    fc.assert(fc.property(fc.webUrl({ validSchemes: ['http', 'https'] }), (url) => {
      const out = sanitizeRichtext(`<a href="${url}">x</a>`)
      expect(out).toContain('target="_blank"')
      expect(out).toMatch(/rel="[^"]*noopener[^"]*"/)
    }))
  })
})

describe('sanitizeRichtext — the exact allowlist (hard-coded expectations, not derived from the source)', () => {
  const ALLOWED_TAGS = [
    'p', 'br', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark',
    'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'hr',
  ]
  const DISALLOWED_TAGS = ['img', 'table', 'tr', 'td', 'iframe', 'svg', 'video', 'form', 'input', 'button']

  it.each(ALLOWED_TAGS)('keeps <%s>', (tag) => {
    expect(sanitizeRichtext(`<${tag}>x</${tag}>`)).toContain(`<${tag}`)
  })

  it.each(DISALLOWED_TAGS)('discards <%s> but keeps its text content (disallowedTagsMode: discard)', (tag) => {
    const out = sanitizeRichtext(`<${tag}>kept-text</${tag}>`)
    expect(out).not.toContain(`<${tag}`)
    expect(out).toContain('kept-text')
  })

  it('discards <style>/<script> AND their content (non-text tags — discard is byte-for-byte gone)', () => {
    expect(sanitizeRichtext('<style>kept-text</style>')).toBe('')
    expect(sanitizeRichtext('<script>kept-text</script>')).toBe('')
  })

  // `target`/`rel` on `<a>` are always overridden by `transformTags`, regardless of the allowlist, so
  // only `href`/`title` are observable here — the rest is `data-evil`/`id` never surviving at all.
  it('keeps href/title on <a>, strips any attribute outside the allowlist', () => {
    const out = sanitizeRichtext('<a href="/x" title="T" data-evil="1" id="y">x</a>')
    expect(out).toContain('href="/x"')
    expect(out).toContain('title="T"')
    expect(out).not.toContain('data-evil')
    expect(out).not.toMatch(/\bid=/)
  })

  it('keeps class/style on every tag, strips an arbitrary attribute', () => {
    const out = sanitizeRichtext('<p class="c" style="text-align: center" data-evil="1">x</p>')
    expect(out).toContain('class="c"')
    expect(out).toContain('text-align:center')
    expect(out).not.toContain('data-evil')
  })

  it('keeps only left/right/center/justify for text-align, strips any other value', () => {
    for (const valid of ['left', 'right', 'center', 'justify']) {
      expect(sanitizeRichtext(`<p style="text-align: ${valid}">x</p>`)).toContain(`text-align:${valid}`)
    }
    expect(sanitizeRichtext('<p style="text-align: initial">x</p>')).not.toContain('text-align')
    // The `^…$`-anchored regex must not match a value merely CONTAINING an allowed word.
    expect(sanitizeRichtext('<p style="text-align: lefty">x</p>')).not.toContain('text-align')
    expect(sanitizeRichtext('<p style="text-align: xleft">x</p>')).not.toContain('text-align')
  })

  it('keeps http/https/mailto/tel/kestrel: hrefs, strips any other scheme', () => {
    expect(sanitizeRichtext('<a href="http://x.example">x</a>')).toContain('href="http://x.example"')
    expect(sanitizeRichtext('<a href="mailto:a@b.example">x</a>')).toContain('href="mailto:a@b.example"')
    expect(sanitizeRichtext('<a href="tel:+123">x</a>')).toContain('href="tel:+123"')
    expect(sanitizeRichtext('<a href="kestrel:posts:1">x</a>')).toContain('href="kestrel:posts:1"')
    expect(sanitizeRichtext('<a href="ftp://x.example">x</a>')).not.toContain('href=')
  })

  it('a relative/internal link keeps no target/rel, even an author-supplied one', () => {
    const out = sanitizeRichtext('<a href="/internal" target="_blank" rel="whatever">x</a>')
    expect(out).not.toContain('target=')
    expect(out).not.toContain('rel=')
  })
})
