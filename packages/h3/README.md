# @michaelthielemann/kestrel-h3
Adapter: serves the HTTP triggers of a booted Kestrel instance as one h3 event handler – for
Nuxt/Nitro (h3 v1) or any h3 app. Same behaviour as the built-in server: route params and
`*path`, query + JSON body → payload, multipart → `files`, binary results, `{ error, runId }`,
`X-Kestrel-Run-Id`, body limit (413), client ip. Options: `mountPath` (`/api`), `maxBodyBytes`,
`inlineTypes`, and the same peer policy as the core server – `trustProxy` (the `X-Forwarded-For`
entry `proxyHops` from the right, default 1; a shorter chain yields no address), `trustedHeader`
(its first value is the client; missing → no address) – derived by the core's `clientIp()`, so
`ctx.ip` (rate limits) cannot drift between the two paths. Boot Kestrel with `http: null`;
health/CORS stay with the host.
Knows no contracts and no modules.
