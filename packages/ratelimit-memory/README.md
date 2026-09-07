# ratelimit/memory
Fixed-window rate limiting per client ip, held in memory (one process). Buckets come from config:
`buckets: { login: { limit: 5, windowSeconds: 60 } }`. Step `ratelimit.check:<bucket>` fails
`RATE_LIMITED` (429, `Retry-After` from `details.retryAfterSeconds`) once the limit is reached; the
bucket name is validated at boot. `ratelimit.sweep` (cron) drops expired windows. Behind a proxy set
`http.trustProxy`/`proxyHops` or `trustedHeader` so the real client ip is used. A request without a
derivable address (`ctx.ip` absent – no trusted header, a forwarding chain shorter than `proxyHops`)
is counted in one shared key `"unknown"` per bucket, so such requests are limited together rather
than skipped; refusing them outright is the job of `http.allow` or the host's middleware.
Not included: shared limits across processes (needs a store-backed module), per-user keys.
