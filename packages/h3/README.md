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
the core server does with 403. A host that does not refuse it lets such requests share one rate-limit
key (`ratelimit-memory` counts them under `"unknown"`). Boot Kestrel with `http: null`;
health/CORS stay with the host.
A path with a `.` or `..` segment (also `%2e`-encoded) answers 400 instead of being resolved. A
handler wrapping the adapter reads the pipeline a request was routed to with `routedPipeline(event)`
(`undefined` when no route matched), so it can decide on the route rather than on the path.

### Request log
With `logger` (the core's `Logger`, e.g. the one passed to `boot()`), the handler writes one
`logger.info("http", …)` line per request with the fields of the core server's line: `runId`
(the `X-Kestrel-Run-Id` of the response), `requestId` (a valid incoming `X-Request-Id`), `method`,
`path` (with the mount path, without the query string), `pipeline`, `status`, `ms` and `ip`. A
request refused before its pipeline ran gets a line too, with a `reason` and, when no route
matched, no `pipeline`:

| Status | `reason` |
|---|---|
| 400 | `invalid path: dot segment` (no `pipeline`; `path` is the raw path) |
| 400 | `invalid body: malformed JSON`, `invalid body: body must be a JSON object`, `invalid multipart body: <cause>` |
| 400 | `body not received: connection closed`, with `declaredBytes`: the client closed the connection before the body was complete |
| 404 | `no route` |
| 408 | `body not received: request timeout`, with `declaredBytes`: the server's `requestTimeout` ended the upload and Node answered 408 |
| 413 | `body exceeds <n> bytes` or `multipart body has more than <n> <parts>`, with `declaredBytes` when the request sent a `Content-Length` |
| 415 | `unsupported content type`, `this route does not accept multipart/form-data` |

A handler that throws writes a line with status 500 and `reason: "handler failed"`, sets the line's
`runId` as `X-Kestrel-Run-Id` and echoes `X-Request-Id`, then rethrows, so the host's error handler
answers. Every response, refusals included, echoes a valid `X-Request-Id` (printable ASCII, at most
200 characters); an invalid one is neither echoed nor logged. `ms` includes the time the body took to
arrive. A line holds no body, no cookie, no query string and no header value except a valid
`X-Request-Id` (`requestId`), the declared `Content-Length` (`declaredBytes`) and the client address
derived under the peer policy (`ip`); `reason` is at most 200 characters.
Without `logger` the handler writes nothing.

Refusals before the pipeline start no run, so they do not reach a run observer such as
`insights/default`; the log line is their only record.

Knows no contracts and no modules.
