export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/')) return // default-deny applies to the API only
  const settings = sessionSettings()
  const decision = evaluateAccess({
    method: getMethod(event),
    path: event.path,
    csrf: {
      secFetchSite: getRequestHeader(event, 'sec-fetch-site'),
      origin: getRequestHeader(event, 'origin'),
      referer: getRequestHeader(event, 'referer'),
      host: getRequestHeader(event, 'host'),
    },
    cookie: getCookie(event, settings.cookieName),
    secret: settings.secret,
    nowMs: Date.now(),
    // The renderer principal is granted to build-time prerender AND to the runtime publisher's render
    // (an in-process ALS context, not a forgeable header) — both render the public site via /api/route.
    isPrerender: import.meta.prerender === true || isRendererContext(),
    // Registry-contributed grants (opt-in layers, e.g. a public proofing back-channel) consulted on top of
    // the hardcoded policy. Empty by default → guard behaviour unchanged.
  }, publicReadableResources(), registeredGrants())
  if (!decision.allow) {
    throw createError({ statusCode: decision.status, statusMessage: decision.message })
  }
  event.context.principal = decision.principal
  event.context.readScope = decision.readScope
  // Sliding-expiry: any authenticated API activity refreshes the session so it stays alive while in use and
  // auto-expires after `maxAge` of inactivity (idle logout). No-op for anonymous/public requests.
  refreshAuthSession(event)
})
