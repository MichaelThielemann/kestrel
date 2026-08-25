import { describe, it, expect } from 'vitest'
import { allowlistMode, parseAllowlist, ipv4ToInt, ipAllowed } from '../../../src/server/utils/ip-allowlist.js'

describe('ip-allowlist', () => {
  describe('allowlistMode', () => {
    it('is off when the list is empty/blank/unset (never enforce with nothing to match)', () => {
      expect(allowlistMode(undefined, undefined)).toBe('off')
      expect(allowlistMode('enforce', '')).toBe('off')
      expect(allowlistMode('enforce', '   ')).toBe('off')
    })
    it('defaults to enforce when a list is present but no mode is set (secure default)', () => {
      expect(allowlistMode(undefined, '1.2.3.4')).toBe('enforce')
      expect(allowlistMode('', '1.2.3.4')).toBe('enforce')
    })
    it('treats an unknown mode as enforce, not open (no silent bypass)', () => {
      expect(allowlistMode('garbage', '1.2.3.4')).toBe('enforce')
    })
    it('honours explicit log and off, case-insensitively', () => {
      expect(allowlistMode('log', '1.2.3.4')).toBe('log')
      expect(allowlistMode('LOG', '1.2.3.4')).toBe('log')
      expect(allowlistMode('off', '1.2.3.4')).toBe('off')
      expect(allowlistMode('disabled', '1.2.3.4')).toBe('off')
    })
  })

  describe('parseAllowlist', () => {
    it('parses a bare IP as /32 and a CIDR as-is', () => {
      expect(parseAllowlist('1.2.3.4')).toHaveLength(1)
      expect(ipAllowed('1.2.3.4', parseAllowlist('1.2.3.4'))).toBe(true)
      expect(ipAllowed('1.2.3.5', parseAllowlist('1.2.3.4'))).toBe(false)
      expect(ipAllowed('10.0.5.9', parseAllowlist('10.0.0.0/16'))).toBe(true)
      expect(ipAllowed('10.1.5.9', parseAllowlist('10.0.0.0/16'))).toBe(false)
    })
    it('accepts the legacy nginx block verbatim (allow …; + # comments, multi-line)', () => {
      const raw = `
        allow 109.109.207.107/32; # Pre Zero
        allow 10.0.0.0/8; # corp
        set_real_ip_from 193.148.161.0/24;
      `
      const cidrs = parseAllowlist(raw)
      expect(cidrs).toHaveLength(3)
      expect(ipAllowed('109.109.207.107', cidrs)).toBe(true)
      expect(ipAllowed('10.55.1.1', cidrs)).toBe(true)
    })
    it('accepts comma- and semicolon-separated lists and drops comments/blanks', () => {
      expect(parseAllowlist('1.1.1.1, 2.2.2.2 ; 3.3.3.3')).toHaveLength(3)
      expect(parseAllowlist('# only a comment\n\n')).toHaveLength(0)
    })
    it('drops invalid tokens instead of throwing', () => {
      expect(parseAllowlist('notanip, 1.2.3.4/99, 999.1.1.1, 1.2.3.4')).toHaveLength(1)
    })
    it('reports each dropped token via onReject, so a mixed list does not fail silently', () => {
      const rejected: string[] = []
      const cidrs = parseAllowlist('1.2.3.4, 2a02:8109::/48, notanip', (token) => rejected.push(token))
      expect(cidrs).toHaveLength(1)
      expect(rejected).toEqual(['2a02:8109::/48', 'notanip'])
    })
    it('does not call onReject for valid tokens', () => {
      const rejected: string[] = []
      parseAllowlist('1.2.3.4, 10.0.0.0/8', (token) => rejected.push(token))
      expect(rejected).toEqual([])
    })
    it('rejects a missing or non-numeric prefix instead of widening it', () => {
      const rejected: string[] = []
      const cidrs = parseAllowlist('203.0.113.10/, 10.0.0.0/0x10, 10.0.0.0/1e1, 10.0.0.0/24.0', (t) => rejected.push(t))
      expect(cidrs).toHaveLength(0)
      expect(rejected).toEqual(['203.0.113.10/', '10.0.0.0/0x10', '10.0.0.0/1e1', '10.0.0.0/24.0'])
      expect(ipAllowed('8.8.8.8', parseAllowlist('203.0.113.10/'))).toBe(false)
    })
    it('keeps only the good CIDR when a bad prefix sits alongside it', () => {
      const cidrs = parseAllowlist('10.0.0.0/8, 203.0.113.10/')
      expect(cidrs).toHaveLength(1)
      expect(ipAllowed('10.1.2.3', cidrs)).toBe(true)
      expect(ipAllowed('8.8.8.8', cidrs)).toBe(false)
    })
    it('still accepts a padded prefix and one spaced away from the slash', () => {
      expect(ipAllowed('10.1.2.3', parseAllowlist('10.0.0.0/ 8'))).toBe(true)
      expect(ipAllowed('10.1.2.3', parseAllowlist('10.0.0.0/008'))).toBe(true)
    })
    it('still honours a deliberate 0.0.0.0/0', () => {
      expect(ipAllowed('8.8.8.8', parseAllowlist('0.0.0.0/0'))).toBe(true)
    })
  })

  describe('ipv4ToInt', () => {
    it('converts dotted-quad to a uint32', () => {
      expect(ipv4ToInt('0.0.0.0')).toBe(0)
      expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff)
      expect(ipv4ToInt('1.2.3.4')).toBe(0x01020304)
    })
    it('unwraps IPv4-mapped IPv6 (::ffff:a.b.c.d) as Node sometimes reports it', () => {
      expect(ipv4ToInt('::ffff:1.2.3.4')).toBe(0x01020304)
    })
    it('returns null for out-of-range octets, real IPv6, and garbage', () => {
      expect(ipv4ToInt('256.1.1.1')).toBeNull()
      expect(ipv4ToInt('2001:db8::1')).toBeNull()
      expect(ipv4ToInt('garbage')).toBeNull()
      expect(ipv4ToInt('')).toBeNull()
    })
  })

  describe('ipAllowed', () => {
    it('matches /32, /24 and the all-catching 0.0.0.0/0', () => {
      expect(ipAllowed('1.2.3.4', parseAllowlist('1.2.3.4/32'))).toBe(true)
      expect(ipAllowed('1.2.3.9', parseAllowlist('1.2.3.0/24'))).toBe(true)
      expect(ipAllowed('9.9.9.9', parseAllowlist('0.0.0.0/0'))).toBe(true)
    })
    it('fails closed for a non-IPv4 client address and for an empty list', () => {
      expect(ipAllowed('2001:db8::1', parseAllowlist('0.0.0.0/0'))).toBe(false)
      expect(ipAllowed('1.2.3.4', [])).toBe(false)
    })
    it('matches an IPv4-mapped client against an IPv4 CIDR', () => {
      expect(ipAllowed('::ffff:10.0.0.5', parseAllowlist('10.0.0.0/24'))).toBe(true)
    })
  })
})
