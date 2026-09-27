# ratelimit/memory
Fixed-window rate limiting, held in memory (one process). Buckets come from config:
`buckets: { login: { limit: 5, windowSeconds: 60 } }`. Step `ratelimit.check:<bucket>` fails
`RATE_LIMITED` (429, `Retry-After` from `details.retryAfterSeconds`) once the limit is reached; the
bucket name is validated at boot. `ratelimit.sweep` (cron) drops expired windows.

**What a bucket counts by** is its `key`:

- `ip` (default): the client address. An IPv6 address counts by its /64 prefix, since one host
  usually holds a whole /64; an IPv4-mapped IPv6 address counts as its IPv4 address. Behind a proxy
  set `http.trustProxy`/`proxyHops` or `trustedHeader`, with the proxy in `http.trustedProxies`, so the
  real client address is used; a peer outside `trustedProxies` is keyed on its own address whatever
  headers it sends. A request without a derivable address (`ctx.ip` absent – a forwarding chain shorter
  than `proxyHops`) is counted in one shared key `"unknown"` per bucket, so such requests are limited
  together rather than skipped; refusing them outright is the job of `http.allow` or the host's
  middleware.
- `username`: the body field `field` names (`username` by default, `email` for a login by e-mail — it
  must be the field the login reads), trimmed, lower-cased and NFKC-normalized, and kept only as a
  digest — one budget per account, however many addresses the attempts come from. A name longer than
  320 characters is refused with 400 before it is counted. Put it next to an `ip` bucket in front of a
  login.
- `identity`: the signed-in identity, for a step after `authn.requireUser` — e.g. in front of
  `authn.changePassword` or `authn.confirmPassword`, so a stolen session cannot guess the current
  password.

**Counting failures only.** With `counts: "failures"` the check lets a request through without
counting it and counts the run only when it ends in 400 or 401 (a refusal that asks for a second
factor does not count); a run that succeeds clears the key. The owner's own sign-ins never use up an
account's budget, and a correct sign-in resets it. It needs a booted instance, since the module
learns how a run ended from the run observer.

**Backoff.** Without `maxBlockSeconds` a key that exceeded its limit waits for the end of its window.
With it, the first block lasts one window, and every further window the key exceeds right after a
block doubles the block, up to `maxBlockSeconds`; once a key has stayed quiet for `maxBlockSeconds`
after its last block, it starts over at one window. For a `username` bucket this is the bound on what a
third party can do to an account it does not own: while it keeps sending wrong passwords, the
account's sign-in is refused for at most `maxBlockSeconds` at a time, and the owner signs in normally
once the attempts stop. A third party who keeps failing can keep an account blocked for as long as it
keeps failing; pair the bucket with `counts: "failures"` and an `ip` bucket, which limits how fast
one address can do that.

Not included: shared limits across processes (needs a store-backed module).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-ratelimit-memory` – module `ratelimit/memory`: provides no contract.

| Config | Type | Required | Default |
|---|---|---|---|
| `buckets` | record | yes | – |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `ratelimit.check:<arg>` | Rate limit bucket <arg>, counted by client address | `ip?`, `payload.username?`, `payload.email?` | – | { username?: string, email?: string, … } | – | 400 an account name longer than 320 characters; 429 too many requests | – | no |
| `ratelimit.sweep` | Drop expired rate-limit windows | – | `result` | – | { removed: number, … } | – | – | no |

Pipelines in `examples/minimal` using these steps:

- **login** (POST /login): **`ratelimit.check:login`** → `authn.login` → `events.emit:auth.loggedIn` → `events.relay`
- **sweepRateLimits** (cron */5 * * * *): **`ratelimit.sweep`**

<!-- kestrel-docs:end -->
