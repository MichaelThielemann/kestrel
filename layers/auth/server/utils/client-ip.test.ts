import { describe, it, expect } from 'vitest'
import type { H3Event } from 'h3'
import { trustProxyDepth, forwardedForHop, clientIp, throttleKey } from './client-ip'

// Minimal stand-in for an H3Event: getRequestIP reads the socket peer; getRequestHeader reads headers.
// Deliberately only the subset those two h3 helpers touch — not a full H3Event — hence the `unknown` hop.
const fakeEvent = (xff?: string, peer: string | undefined = '9.9.9.9'): H3Event => ({
  context: {},
  node: { req: { headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer } } },
}) as unknown as H3Event

describe('client-ip', () => {
  describe('trustProxyDepth', () => {
    it('defaults to 0 (XFF untrusted) when unset/blank/false/garbage', () => {
      expect(trustProxyDepth({})).toBe(0)
      expect(trustProxyDepth({ KESTREL_TRUST_PROXY: '' })).toBe(0)
      expect(trustProxyDepth({ KESTREL_TRUST_PROXY: 'false' })).toBe(0)
      expect(trustProxyDepth({ KESTREL_TRUST_PROXY: 'off' })).toBe(0)
      expect(trustProxyDepth({ KESTREL_TRUST_PROXY: '0' })).toBe(0)
      expect(trustProxyDepth({ KESTREL_TRUST_PROXY: '-2' })).toBe(0)
      expect(trustProxyDepth({ KESTREL_TRUST_PROXY: 'garbage' })).toBe(0)
    })
    it('treats truthy flags as a single trusted proxy', () => {
      for (const v of ['true', 'on', 'yes', '1', 'TRUE']) {
        expect(trustProxyDepth({ KESTREL_TRUST_PROXY: v })).toBe(1)
      }
    })
    it('honours an explicit hop depth', () => {
      expect(trustProxyDepth({ KESTREL_TRUST_PROXY: '2' })).toBe(2)
      expect(trustProxyDepth({ KESTREL_TRUST_PROXY: '3' })).toBe(3)
    })
  })

  describe('forwardedForHop', () => {
    it('takes the right-most entry at depth 1 (what the nearest proxy observed)', () => {
      expect(forwardedForHop('1.1.1.1, 2.2.2.2, 3.3.3.3', 1)).toBe('3.3.3.3')
    })
    it('skips trusted proxies for a deeper chain', () => {
      expect(forwardedForHop('1.1.1.1, 2.2.2.2, 3.3.3.3', 2)).toBe('2.2.2.2')
    })
    it('returns undefined for depth < 1 or a chain shorter than the trusted depth', () => {
      expect(forwardedForHop('1.1.1.1', 0)).toBeUndefined()
      expect(forwardedForHop('1.1.1.1', 2)).toBeUndefined()
      expect(forwardedForHop('', 1)).toBeUndefined()
      expect(forwardedForHop(undefined, 1)).toBeUndefined()
    })
  })

  describe('clientIp', () => {
    it('ignores X-Forwarded-For by default, keying on the socket peer address', () => {
      expect(clientIp(fakeEvent('1.1.1.1, 2.2.2.2'), {})).toBe('9.9.9.9')
    })
    it('honours the right-most X-Forwarded-For hop when KESTREL_TRUST_PROXY is enabled', () => {
      expect(clientIp(fakeEvent('1.1.1.1, 2.2.2.2'), { KESTREL_TRUST_PROXY: 'true' })).toBe('2.2.2.2')
      expect(clientIp(fakeEvent('1.1.1.1, 2.2.2.2, 3.3.3.3'), { KESTREL_TRUST_PROXY: '2' })).toBe('2.2.2.2')
    })
    it('falls back to the peer when trusted but XFF is missing or too short', () => {
      expect(clientIp(fakeEvent(undefined), { KESTREL_TRUST_PROXY: 'true' })).toBe('9.9.9.9')
      expect(clientIp(fakeEvent('1.1.1.1'), { KESTREL_TRUST_PROXY: '2' })).toBe('9.9.9.9')
    })
    it('falls back to "unknown" when there is no peer address either', () => {
      const noPeer = { context: {}, node: { req: { headers: {}, socket: {} } } } as unknown as H3Event
      expect(clientIp(noPeer, {})).toBe('unknown')
    })
  })

  describe('throttleKey', () => {
    it('leaves an IPv4 address at its full /32', () => {
      expect(throttleKey('198.51.100.5')).toBe('198.51.100.5')
    })
    it('leaves an IPv4-mapped IPv6 address (::ffff:a.b.c.d) unchanged', () => {
      expect(throttleKey('::ffff:198.51.100.5')).toBe('::ffff:198.51.100.5')
    })
    it('leaves the "unknown" sentinel unchanged', () => {
      expect(throttleKey('unknown')).toBe('unknown')
    })
    it('coarsens a real IPv6 address to its routed /64, dropping the low 64 bits an attacker can rotate for free', () => {
      // A /64 is 4 hextets; two addresses differing only past the 4th hextet must key identically.
      expect(throttleKey('2001:db8:aaaa:1::1')).toBe(throttleKey('2001:db8:aaaa:1::ffff'))
      expect(throttleKey('2001:db8:aaaa:1:2:3:4:5')).toBe(throttleKey('2001:db8:aaaa:1::9'))
    })
    it('does not coarsen across a /64 boundary', () => {
      expect(throttleKey('2001:db8:aaaa:1::1')).not.toBe(throttleKey('2001:db8:aaaa:2::1'))
    })
    it('handles leading and trailing "::" compression', () => {
      expect(throttleKey('::1')).toBe(throttleKey('::2'))
      expect(throttleKey('fe80::')).toBe(throttleKey('fe80::1'))
    })
    it('falls back to the raw address for anything it cannot parse as IPv6 (fails to the old, stricter /128 key)', () => {
      expect(throttleKey('garbage')).toBe('garbage')
    })
  })
})
