export interface CsrfHeaders {
  secFetchSite?: string | null
  origin?: string | null
  referer?: string | null
  host?: string | null
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export function isCrossSiteWrite(h: CsrfHeaders): boolean {
  if (h.secFetchSite) {
    return !(h.secFetchSite === 'same-origin' || h.secFetchSite === 'none')
  }
  // hostOf() lowercases per the URL spec; the raw Host header does not, so normalize both
  // sides — host comparison is case-insensitive (RFC 3986).
  const host = (h.host ?? '').toLowerCase()
  // The literal opaque origin `null` (a browser signal from a sandboxed iframe, a data: URL, or some
  // redirect chains) is unparseable by new URL, so it must NOT fall through to the all-absent "allow"
  // path — per spec it is cross-origin. Treat it as cross-site.
  if (h.origin === 'null') return true
  const originHost = hostOf(h.origin)
  if (originHost !== null) return originHost !== host
  const refererHost = hostOf(h.referer)
  if (refererHost !== null) return refererHost !== host
  // A write carrying NONE of Sec-Fetch-Site / Origin / Referer is treated as same-site (allowed). A
  // browser ALWAYS attaches Origin and/or Sec-Fetch-Site to a cross-origin state-changing request, so
  // the all-absent case can only come from a NON-browser client (the test harness, a server-to-server
  // import, automation) — which carries no ambient cookies and therefore cannot mount CSRF. The real
  // defenses are SameSite=Strict on the session cookie + the Origin/Referer checks above; failing closed
  // here adds no protection and breaks legitimate authenticated API clients.
  return false
}
