# @michaelthielemann/kestrel-h3
Adapter: serves the HTTP triggers of a booted Kestrel instance as one h3 event handler – for
Nuxt/Nitro (h3 v1) or any h3 app. Same behaviour as the built-in server: route params and
`*path`, query + JSON body → payload, multipart → `files`, binary results, `{ error, runId }`,
`X-Kestrel-Run-Id`, body limit (413 on a `Content-Length` over `maxBodyBytes` before reading, and
as soon as a streamed body passes it; the same `readRequestBody` as the core server), multipart
limits (`multipart: { maxParts, maxFiles, maxFields }`, defaults 120/20/100, 413 at the first part
past them; 415 for a multipart body to a route whose pipeline reads no files), client ip. Options: `mountPath` (default `""`, e.g. `/api`), `maxBodyBytes`,
`inlineTypes`, and the same peer policy as the core server – `trustedProxies` (default loopback;
forwarding headers of any other peer are ignored and the peer is the client), `trustProxy` (the
`X-Forwarded-For` entry `proxyHops` from the right, default 1; a shorter chain yields no address),
`trustedHeader` (the value the trusted proxy set last is the client) – derived by the core's
`clientIpResolver()`, so `ctx.ip` (rate limits) cannot drift between the two paths. A trusted proxy
that omits the trusted header leaves `ctx.ip` absent; refusing such a request is the host's job, as
the core server does with 403. Boot Kestrel with `http: null`;
health/CORS stay with the host.
Knows no contracts and no modules.
