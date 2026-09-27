# ratelimit/memory
Fixed-window rate limiting per client ip, held in memory (one process). Buckets come from config:
`buckets: { login: { limit: 5, windowSeconds: 60 } }`. Step `ratelimit.check:<bucket>` fails
`RATE_LIMITED` (429, `Retry-After` from `details.retryAfterSeconds`) once the limit is reached; the
bucket name is validated at boot. `ratelimit.sweep` (cron) drops expired windows. Behind a proxy set
`http.trustProxy`/`proxyHops` or `trustedHeader`, with the proxy in `http.trustedProxies`, so the real
client ip is used; a peer outside `trustedProxies` is keyed on its own address whatever headers it
sends. A request without a derivable address (`ctx.ip` absent – a forwarding chain shorter than `proxyHops`)
is counted in one shared key `"unknown"` per bucket, so such requests are limited together rather
than skipped; refusing them outright is the job of `http.allow` or the host's middleware.
Not included: shared limits across processes (needs a store-backed module), per-user keys.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-ratelimit-memory` – module `ratelimit/memory`: provides no contract.

| Config | Type | Required | Default |
|---|---|---|---|
| `buckets` | record | yes | – |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `ratelimit.check:<arg>` | Rate limit bucket <arg> | – | – | – | – | 429 too many requests | – | no |
| `ratelimit.sweep` | Drop expired rate-limit windows | – | `result` | – | { removed: number, … } | – | – | no |

Pipelines in `examples/minimal` using these steps:

- **login** (POST /login): **`ratelimit.check:login`** → `authn.login` → `events.emit:auth.loggedIn` → `events.relay`
- **sweepRateLimits** (cron */5 * * * *): **`ratelimit.sweep`**

<!-- kestrel-docs:end -->
