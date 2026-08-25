import { describe, it, expect } from 'vitest'
import { sanitizeSvg } from '../../../src/server/utils/sanitize-svg.js'

describe('sanitizeSvg', () => {
  it('keeps drawing markup', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    expect(out).toContain('<rect')
    expect(out).toContain('<svg')
  })
  it('strips <script>', () => {
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>')).not.toContain('script')
  })
  it('strips event handlers and javascript: hrefs', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/><a xlink:href="javascript:alert(1)"/></svg>')
    expect(out).not.toContain('onload')
    expect(out).not.toContain('javascript:')
  })
})
