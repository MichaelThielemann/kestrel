export type AllowlistMode = 'enforce' | 'log' | 'off'

/** A parsed IPv4 CIDR as `network base & mask`, both uint32. */
export interface Cidr {
  base: number
  mask: number
}

/**
 * Resolve the gate mode from `KESTREL_IP_ALLOWLIST_MODE` given the raw list.
 *
 * An empty list means there is nothing to enforce → `off`. When a list IS present, an unset/unknown mode
 * defaults to `enforce`: a configured allow-list that silently let everyone through is the exact legacy
 * footgun we are replacing. `log` is the opt-in calibration mode (observe, never block) used to confirm the
 * resolved client IP + `KESTREL_TRUST_PROXY` depth before enforcing.
 */
export function allowlistMode(modeRaw: string | undefined, listRaw: string | undefined): AllowlistMode {
  if (!listRaw || !listRaw.trim()) return 'off'
  const m = (modeRaw ?? '').trim().toLowerCase()
  if (m === 'off' || m === 'disabled' || m === 'false') return 'off'
  if (m === 'log' || m === 'log-only' || m === 'dry-run') return 'log'
  return 'enforce'
}

/** `1.2.3.4` / `::ffff:1.2.3.4` → uint32; `null` for out-of-range, real IPv6, or non-IPv4 input. */
export function ipv4ToInt(ip: string): number | null {
  let s = ip.trim()
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(s)
  if (mapped) s = mapped[1]!
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i])
    if (octet > 255) return null
    n = n * 256 + octet
  }
  return n >>> 0
}

function parseCidr(token: string): Cidr | null {
  const slash = token.indexOf('/')
  const base = ipv4ToInt(slash === -1 ? token : token.slice(0, slash))
  if (base === null) return null
  // `Number()` alone would widen a malformed prefix into a mask: '' → 0 → 0.0.0.0/0, and '0x10'/'1e1' → 16/10.
  const bitsRaw = slash === -1 ? '32' : token.slice(slash + 1).trim()
  if (!/^\d+$/.test(bitsRaw)) return null
  const bits = Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return { base: (base & mask) >>> 0, mask }
}

/**
 * Parse the allow-list env into CIDRs, tolerant of the legacy nginx block so it can be pasted verbatim:
 * newline/comma/semicolon separated, `# comments` and a leading `allow`/`set_real_ip_from` keyword stripped.
 * Invalid tokens are dropped, not thrown — one bad line must not disable the whole gate. `onReject`, when
 * given, is called with each dropped token (this parser is IPv4-only, so an IPv6 CIDR pasted into an
 * otherwise-valid list is silently a no-op unless the caller surfaces it).
 */
export function parseAllowlist(raw: string | undefined, onReject?: (token: string) => void): Cidr[] {
  if (!raw) return []
  const out: Cidr[] = []
  for (const part of raw.split(/[\n,;]+/)) {
    const token = part.replace(/#.*$/, '').trim().replace(/^(?:allow|set_real_ip_from)\s+/i, '').trim()
    if (!token) continue
    const cidr = parseCidr(token)
    if (cidr) out.push(cidr)
    else onReject?.(token)
  }
  return out
}

/** True when `ip` falls in any CIDR. Fails closed: a non-IPv4 address or empty list never matches. */
export function ipAllowed(ip: string, cidrs: Cidr[]): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  return cidrs.some((c) => ((n & c.mask) >>> 0) === c.base)
}
