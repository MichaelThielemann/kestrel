import { getRequestIP, getRequestHeader } from 'h3'
import type { H3Event } from 'h3'

type Env = Record<string, string | undefined>

/**
 * How many reverse-proxy hops to trust in front of the app, parsed from `KESTREL_TRUST_PROXY`.
 *
 * Default **0** == trust nothing == ignore `X-Forwarded-For` entirely (without a proxy in front, XFF is
 * fully attacker-controlled). `true`/`on`/`yes`/`1` == one trusted proxy; a positive integer == that many
 * chained trusted proxies (e.g. CDN → load balancer). Anything else (`false`/`0`/blank/garbage) == 0.
 */
export function trustProxyDepth(env: Env = process.env): number {
  const raw = (env.KESTREL_TRUST_PROXY ?? '').trim().toLowerCase()
  if (!raw) return 0
  if (raw === 'true' || raw === 'on' || raw === 'yes') return 1
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Pick the client address from an `X-Forwarded-For` chain, counting `depth` hops from the RIGHT.
 *
 * XFF is appended left-to-right (`client, proxy1, proxy2`), so the entries a client can forge sit on the
 * LEFT and the right-most entry is the address our nearest trusted proxy actually observed. With one
 * trusted proxy (depth 1) we take the right-most entry; with N chained trusted proxies we skip the N-1
 * proxy hops and take the Nth-from-right. (h3's own `getRequestIP({ xForwardedFor: true })` takes the
 * LEFT-most — spoofable — value, which is exactly why we don't use it.)
 *
 * If the chain is shorter than the trusted depth, it didn't traverse the expected proxies → untrustworthy,
 * so we return `undefined` and let the caller fall back to the socket peer rather than honour a forged value.
 */
export function forwardedForHop(header: string | undefined, depth: number): string | undefined {
  if (depth < 1) return undefined
  const parts = (header ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const idx = parts.length - depth
  return idx >= 0 ? parts[idx] : undefined
}

/**
 * The client IP used to key the login throttle.
 *
 * Trusting `X-Forwarded-For` unconditionally lets a direct client rotate the header to dodge the per-IP
 * limit, so by default we key on the socket peer address and ignore XFF. Only when `KESTREL_TRUST_PROXY`
 * declares a trusted proxy depth do we honour the correct (right-most) XFF hop; a missing/too-short chain
 * still falls back to the peer.
 * @public
 */
export function clientIp(event: H3Event, env: Env = process.env): string {
  const depth = trustProxyDepth(env)
  if (depth > 0) {
    const forwarded = forwardedForHop(getRequestHeader(event, 'x-forwarded-for'), depth)
    if (forwarded) return forwarded
  }
  return getRequestIP(event) ?? 'unknown'
}

/** Expand a syntactically valid IPv6 address (optionally `::`-compressed) into its 8 hextets, or `null`. */
function ipv6Hextets(ip: string): string[] | null {
  const compressAt = ip.indexOf('::')
  if (compressAt === -1) {
    const groups = ip.split(':')
    return groups.length === 8 ? groups : null
  }
  if (ip.indexOf('::', compressAt + 1) !== -1) return null // more than one '::' is not valid IPv6
  const left = ip.slice(0, compressAt)
  const right = ip.slice(compressAt + 2)
  const leftGroups = left === '' ? [] : left.split(':')
  const rightGroups = right === '' ? [] : right.split(':')
  const missing = 8 - leftGroups.length - rightGroups.length
  if (missing < 0) return null
  return [...leftGroups, ...Array(missing).fill('0'), ...rightGroups]
}

/**
 * The key used to bucket the login throttle: an IPv4 (and IPv4-mapped `::ffff:a.b.c.d`) address stays a
 * full /32 — NAT already shares those legitimately, so widening the bucket there would throttle unrelated
 * users behind the same NAT. A real IPv6 address is coarsened to its first four hextets (a /64), the block
 * an ISP typically routes to a single customer — otherwise an attacker on a routed /64 binds a fresh source
 * address per request and `recentFails` never sees the same key twice, so the throttle bounds nothing.
 * Anything that isn't well-formed IPv4 or IPv6 (including the `unknown` fallback) is returned unchanged,
 * which is only ever as permissive as the pre-existing full-address key.
 * @public
 */
export function throttleKey(ip: string): string {
  if (ip.includes('.') || !ip.includes(':')) return ip
  const hextets = ipv6Hextets(ip)
  if (!hextets) return ip
  return hextets.slice(0, 4).join(':') + '::/64'
}
