# ratelimit/memory
Fixed-window rate limiting per client ip, held in memory (one process). Buckets come from config:
`buckets: { login: { limit: 5, windowSeconds: 60 } }`. Step `ratelimit.check:<bucket>` fails
`RATE_LIMITED` (429, `Retry-After` from `details.retryAfterSeconds`) once the limit is reached; the
bucket name is validated at boot. `ratelimit.sweep` (cron) drops expired windows. Behind a proxy set `http.trustProxy` so the real client ip is used.
Not included: shared limits across processes (needs a store-backed module), per-user keys.
