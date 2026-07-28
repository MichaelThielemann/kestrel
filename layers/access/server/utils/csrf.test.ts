import { describe, it, expect } from 'vitest'
import { isCrossSiteWrite } from './csrf'

const host = 'cms.example.com'

describe('isCrossSiteWrite', () => {
  it('allows same-origin / none Sec-Fetch-Site', () => {
    expect(isCrossSiteWrite({ secFetchSite: 'same-origin', host })).toBe(false)
    expect(isCrossSiteWrite({ secFetchSite: 'none', host })).toBe(false)
  })

  it('rejects cross-site and same-site Sec-Fetch-Site', () => {
    expect(isCrossSiteWrite({ secFetchSite: 'cross-site', host })).toBe(true)
    expect(isCrossSiteWrite({ secFetchSite: 'same-site', host })).toBe(true)
  })

  it('falls back to Origin host vs Host when Sec-Fetch-Site is absent', () => {
    expect(isCrossSiteWrite({ origin: 'https://cms.example.com', host })).toBe(false)
    expect(isCrossSiteWrite({ origin: 'https://evil.com', host })).toBe(true)
  })

  it('falls back to Referer host when Origin is absent', () => {
    expect(isCrossSiteWrite({ referer: 'https://cms.example.com/page', host })).toBe(false)
    expect(isCrossSiteWrite({ referer: 'https://evil.com/x', host })).toBe(true)
  })

  it('treats the opaque Origin: null (sandboxed iframe / data: URL) as cross-site', () => {
    expect(isCrossSiteWrite({ origin: 'null', host })).toBe(true)
  })

  it('compares hosts case-insensitively (mixed-case Host is not cross-site)', () => {
    expect(isCrossSiteWrite({ origin: 'https://cms.example.com', host: 'CMS.example.com' })).toBe(false)
    expect(isCrossSiteWrite({ referer: 'https://CMS.example.com/x', host: 'cms.example.com' })).toBe(false)
  })

  it('allows a write with NO browser signal (non-browser client — cannot mount CSRF)', () => {
    // A browser always attaches Origin and/or Sec-Fetch-Site to a cross-origin write, so an all-absent
    // request can only be a non-browser client (test harness / server-to-server / automation), which
    // carries no ambient cookies and can't mount CSRF. SameSite=Strict + the Origin/Referer checks are
    // the real defenses; failing closed here only breaks legitimate authenticated API clients.
    expect(isCrossSiteWrite({ host })).toBe(false)
    expect(isCrossSiteWrite({})).toBe(false)
  })
})
