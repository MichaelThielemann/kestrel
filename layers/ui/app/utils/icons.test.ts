import { describe, it, expect } from 'vitest'
import { icons, isIconName, resolveIconBody, sanitizeIconSvg } from './icons'

describe('isIconName', () => {
  it('recognises registry keys and rejects others', () => {
    expect(isIconName('settings')).toBe(true)
    expect(isIconName('file-text')).toBe(true)
    expect(isIconName('not-an-icon')).toBe(false)
    expect(isIconName('<path/>')).toBe(false)
  })
})

describe('resolveIconBody', () => {
  it('returns the stored body for a registry name', () => {
    expect(resolveIconBody('settings')).toBe(icons.settings)
  })

  it('treats raw inner-SVG markup as-is (after sanitising)', () => {
    expect(resolveIconBody('<path d="M1 2"/>')).toBe('<path d="M1 2"/>')
  })

  it('unwraps a full <svg> element to its children', () => {
    expect(resolveIconBody('<svg viewBox="0 0 24 24"><circle cx="1" cy="2" r="3"/></svg>'))
      .toBe('<circle cx="1" cy="2" r="3"/>')
  })

  it('renders nothing for an unknown bare string', () => {
    expect(resolveIconBody('definitely-not-svg')).toBe('')
  })
})

describe('sanitizeIconSvg', () => {
  it('keeps allowed elements/attributes and drops <script>, <a> and handlers', () => {
    const dirty = '<path d="M0 0"/><script>alert(1)</script><a onclick="x()" href="javascript:evil()">y</a>'
    const clean = sanitizeIconSvg(dirty)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('<a')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('javascript:')
    expect(clean).toContain('<path d="M0 0"/>')
  })

  it('drops elements that are not on the allowlist, regardless of attribute separator', () => {
    // exact denylist-bypass vectors a naive regex/denylist sanitiser would miss
    for (const vector of [
      '<img/onerror=alert(1) src=x>',
      '<image/onerror=alert(1) href=x />',
      '<animate/onbegin=alert(1) attributeName=x dur=1s/>',
      '<svg><foreignObject><body onload=alert(1)></body></foreignObject></svg>',
    ]) {
      const clean = sanitizeIconSvg(vector)
      expect(clean.toLowerCase()).not.toContain('onerror')
      expect(clean.toLowerCase()).not.toContain('onbegin')
      expect(clean.toLowerCase()).not.toContain('onload')
      expect(clean).not.toContain('<img')
      expect(clean).not.toContain('<animate')
    }
  })

  it('strips disallowed attributes (incl. /-separated handlers) from an allowed element', () => {
    expect(sanitizeIconSvg('<path/onclick=alert(1) d="M1 1"/>')).toBe('<path d="M1 1"/>')
    expect(sanitizeIconSvg('<path d="M0 0" onerror=alert(1)>')).toBe('<path d="M0 0">')
  })

  it('preserves case-sensitive SVG element/attribute names', () => {
    const out = sanitizeIconSvg('<linearGradient gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="red"/></linearGradient>')
    expect(out).toContain('<linearGradient gradientUnits="userSpaceOnUse">')
    expect(out).toContain('<stop offset="0" stop-color="red"/>')
  })

  it('defangs script-capable markup routed through resolveIconBody', () => {
    expect(resolveIconBody('<path/><script>steal()</script>')).not.toContain('<script')
    expect(resolveIconBody('<img/onerror=alert(1) src=x>').toLowerCase()).not.toContain('onerror')
  })
})
