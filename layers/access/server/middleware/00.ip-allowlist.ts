// Stage-level IP gate: the ENFORCEMENT of an allow-list Kestrel provides; the list itself is consumer
// config (env `KESTREL_IP_ALLOWLIST`, typically only on non-public DEV/EDIT stages). Runs before the API
// access-guard (00. sort prefix) and covers every route this app defines — the admin UI, public preview,
// and API. It does NOT cover assets Nitro serves itself ahead of this stack (`/_nuxt/**`, and `/uploads`
// when `media.driver: 'local'`) — the `00.` prefix only orders files within this layer, while Nitro's own
// static handler is unconditionally unshifted to the front of the whole handler list. `off` when no list
// is set → zero cost on PROD/local.
function loadConfig() {
  const listRaw = process.env.KESTREL_IP_ALLOWLIST
  const mode = allowlistMode(process.env.KESTREL_IP_ALLOWLIST_MODE, listRaw)
  // Named per-token, not just a "0 valid CIDRs" count — a mixed list (one good entry, one IPv6 CIDR this
  // IPv4-only parser can never match) would otherwise silently under-enforce with no diagnostic at all.
  const cidrs = parseAllowlist(listRaw, (token) => {
    console.warn(`[ip-allowlist] dropping unparseable/unsupported allow-list entry "${token}" (IPv4/CIDR only)`)
  })
  if (mode !== 'off' && cidrs.length === 0) {
    console.warn('[ip-allowlist] KESTREL_IP_ALLOWLIST is set but parsed to 0 valid CIDRs — enforce mode will block ALL traffic')
  }
  return { mode, cidrs }
}

// Env is fixed for the process lifetime → parse the (up to a few hundred) CIDRs once, not per request.
let configured: ReturnType<typeof loadConfig> | undefined

// A listener that never shows the gate a usable client address blocks everything, which looks like an
// outage rather than a misconfiguration unless we say once what to set.
let warnedUnresolvable = false

export default defineEventHandler((event) => {
  configured ??= loadConfig()
  const { mode, cidrs } = configured
  if (mode === 'off') return

  // The runtime publisher renders the public site via a nested in-process $fetch (renderer principal), and
  // build-time prerender the same. Neither is an external client — exempt them or publishing 403s itself.
  if (import.meta.prerender === true || isRendererContext()) return

  // Nitro's other in-process sub-requests (the SSR page's own `$fetch`, the preview) run through this
  // stack on a mocked socket with no peer, so they could never match a CIDR — gating them would 403 the
  // very pages the gate protects. They are recognised by the async context of the request that spawned
  // them: a missing peer alone is NOT a pass, or a listener that reports none for anybody (a unix domain
  // socket) would turn the gate into a silent no-op.
  if (isStageGatePassedContext() && !event.node?.req?.socket?.remoteAddress) return

  const ip = clientIp(event)
  if (ipAllowed(ip, cidrs)) {
    // The in-process sub-requests this one spawns inherit the decision (see above).
    markStageGatePassed()
    return
  }

  if (ipv4ToInt(ip) === null && !warnedUnresolvable) {
    warnedUnresolvable = true
    console.warn(`[ip-allowlist] cannot resolve an IPv4 client address (got "${ip}") — such requests are blocked in enforce mode; set KESTREL_TRUST_PROXY when a reverse proxy fronts this listener`)
  }

  if (mode === 'log') {
    // Calibration mode: never block, just surface what the gate WOULD reject so the operator can confirm
    // the resolved client IP + KESTREL_TRUST_PROXY depth before switching to enforce.
    console.warn(`[ip-allowlist] would block ${ip} — ${event.method} ${event.path} (xff=${getRequestHeader(event, 'x-forwarded-for') ?? '-'})`)
    // Nothing is blocked in this mode, so the report is about the external request, not the in-process
    // renders it goes on to spawn.
    markStageGatePassed()
    return
  }
  throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
})
