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

**Counting failures only.** With `counts: "failures"` the check counts each request it lets through
as an attempt in progress and settles it when the run ends: a run that ends in 400 or 401 keeps the
attempt as a failure, a run that succeeds clears the key, and any other end (a refusal that asks for a
second factor, a server error) gives the attempt back. Parallel requests therefore never get more than
`limit` attempts through at once, while the owner's own sign-ins never use up an account's budget and a
correct sign-in resets it. It needs a booted instance, since the module learns how a run ended from the
run observer.

**Backoff.** Without `maxBlockSeconds` a key that exceeded its limit waits for the end of its window.
With it, the first block lasts one window, and every further window the key exceeds right after a
block doubles the block, up to `maxBlockSeconds`; once a key has stayed quiet for `maxBlockSeconds`
after its last block, it starts over at one window. For a `username` bucket this is the bound on what a
third party can do to an account it does not own: while it keeps sending wrong passwords, the
account's sign-in is refused for at most `maxBlockSeconds` at a time, and the owner signs in normally
once the attempts stop. A third party who keeps failing can keep an account blocked for as long as it
keeps failing; pair the bucket with `counts: "failures"` and an `ip` bucket, which limits how fast
one address can do that, and with `knownDevices`, which keeps the owner's own devices out of the
block.

**Known devices.** A `username` bucket blocks the account for everyone once its budget is used up,
so a third party can keep its owner from signing in. `knownDevices` gives every device the account
signed in from before a budget of its own. `ratelimit.rememberDevice:<bucket>`, placed after the
login and any second-factor step, hands the device a signed cookie bound to the account the bucket
counts by. A request that carries a valid cookie for the account it names is counted in that
device's budget instead of the account's, so it is neither stopped by nor adds to the account's
block. Without the cookie, with one for another account, or once the device has used up its own
budget, a request is counted against the account as before. A stolen cookie therefore only helps
with the one account, and only for the device's own budget.

```ts
{
  buckets: {
    login: { limit: 5, windowSeconds: 60 },
    loginAccount: {
      limit: 10, windowSeconds: 300, maxBlockSeconds: 900, key: "username", counts: "failures",
      knownDevices: { limit: 10, windowSeconds: 300, maxBlockSeconds: 900 },
    },
  },
  deviceCookies: { secretKey: process.env.DEVICE_KEY },
}
// login: ratelimit.check:login > ratelimit.check:loginAccount > authn.login > mfa.check > ratelimit.rememberDevice:loginAccount
```

The device budget counts the way its bucket does (`counts`, the backoff of `maxBlockSeconds`), and
a successful sign-in from the device clears it without touching the account's. The check leaves
`knownDevice` on the context for a known device, which `mfa-totp`'s `mfa.check` reads to keep that
device clear of the lock wrong codes from other devices set.

The cookie is `__Host-kestrel_device` (`kestrel_device` with `secure: false`, for plain-HTTP
development only): `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, with `Max-Age` and an expiry
inside the signed value, both `maxAgeSeconds` (default 30 days). Every successful sign-in issues a
fresh one. A browser holds one device cookie, for the account that signed in last. The value is an
HMAC-SHA-256 signature over the expiry, a random device id and the account, under a key derived from
`deviceCookies.secretKey` (32 bytes, 64 hex digits or 43 base64url characters, kept outside the
code). To change the key, set the new one as `secretKey` and list the old one in
`previousSecretKeys`: cookies signed under it stay valid until they expire. Dropping a key ends
every cookie it signed; the devices sign in against the account budget again until their next
successful sign-in. The budgets live in memory like every other key, so a restart forgets them,
while the cookies stay valid.

`knownDevices` needs `deviceCookies` and a `username` bucket, and `ratelimit.rememberDevice` needs a
bucket with `knownDevices` and an earlier step that signs the caller in; the boot refuses anything
else.

Not included: shared limits across processes (needs a store-backed module).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-ratelimit-memory` – module `ratelimit/memory`: provides no contract.

| Config | Type | Required | Default |
|---|---|---|---|
| `buckets` | record | yes | – |
| `deviceCookies` | object | no | – |
| `deviceCookies.secretKey` | string | no | *(secret)* |
| `deviceCookies.previousSecretKeys` | array | no | *(secret)* |
| `deviceCookies.maxAgeSeconds` | integer | no | `2592000` |
| `deviceCookies.secure` | boolean | no | `true` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `ratelimit.check:<arg>` | Rate limit bucket <arg>, counted by client address | `ip?`, `payload.username?`, `payload.email?`, `headers.cookie?` | – | { username?: string, email?: string, … } | – | 400 an account name longer than 320 characters; 429 too many requests | – | no |
| `ratelimit.rememberDevice:<arg>` | After a successful sign-in: hand the device a signed device cookie bound to the account bucket <arg> counts by, so its next sign-ins count against the device's own budget | `identity`, `payload.username?`, `payload.email?` | `responseCookies?` | { username?: string, email?: string, … } | – | – | – | no |
| `ratelimit.sweep` | Drop expired rate-limit windows | – | `result` | – | { removed: number, … } | – | – | no |

Pipelines in `examples/minimal` using these steps:

- **login** (POST /login): **`ratelimit.check:login`** → `authn.login` → `events.emit:auth.loggedIn` → `events.relay`
- **sweepRateLimits** (cron */5 * * * *): **`ratelimit.sweep`**

<!-- kestrel-docs:end -->
