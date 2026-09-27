# authn/single
One user from config (`username`, scrypt `passwordHash`, `roles` → `claims.roles`), sessions held in memory with a TTL.
Needs no other contract.

Every step returns a `Result`; the in-memory implementation never answers `TRANSIENT`, so the only
client-visible failure is `UNAUTHENTICATED` (401). `authn.loadIdentity` and `authn.logout` expect a
pipeline that runs `authn.requireUser` first (boot's dataflow check enforces it) and answer
`UNAUTHENTICATED` when identity or token is missing anyway.

Login derives the scrypt key on the libuv thread pool (`verifyPasswordAsync`) and does so for any
username, so a wrong username takes as long as a wrong password.

A failed login answers 401 with `details.username`, the name that was tried; the password is never
repeated anywhere. A
`username` longer than 320 characters is refused with 400 before it is looked up.

`authn.login` answers the token in the body and sets it as the `kestrel_token` cookie (`HttpOnly`,
`Secure`, `SameSite=Strict`, `Path=/`, `Max-Age` = `sessionTtlSeconds`); `authn.logout` removes it.
`secureCookie: false` drops `Secure`, for signing in over plain HTTP during development only. A
`POST`/`PUT`/`PATCH`/`DELETE` authenticated by the cookie rather than a bearer token must come from
the same origin (`Sec-Fetch-Site: same-origin`, or an `Origin` matching `Host`); otherwise
`authn.identifyUser` and `authn.requireUser` answer `FORBIDDEN` (403).

| Step | reads | writes | errors |
|---|---|---|---|
| `authn.login` | – | `token`, `identity`, `responseHeaders`, `result` | `UNAUTHENTICATED` |
| `authn.identifyUser` | – | `token?`, `identity?` | `FORBIDDEN` |
| `authn.requireUser` | – | `token`, `identity` | `UNAUTHENTICATED`, `FORBIDDEN` |
| `authn.loadIdentity` | `identity` | `result` | `UNAUTHENTICATED` |
| `authn.logout` | `token` | `responseHeaders`, `result` | `UNAUTHENTICATED` |

Generate a hash: `node -e "import('@michaelthielemann/kestrel-authn-single/impl').then(m => console.log(m.hashPassword(process.argv[1])))" -- <password>`
Not included: multiple users, persistence of sessions across restarts, password change. On its own it is
a password-only sign-in, meant for a local or development setup; an admin interface that must meet a
multi-factor requirement uses `authn-multi` with `mfa-totp`.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authn-single` – module `authn/single`: provides `authn@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `username` | string | yes | – |
| `passwordHash` | string | yes | *(secret)* |
| `sessionTtlSeconds` | integer | no | `86400` |
| `secureCookie` | boolean | no | `true` |
| `roles` | array | no | `[]` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `authn.login` | Log in with credentials; the token comes back in the body and in an HttpOnly session cookie | – | `token`, `identity`, `responseHeaders`, `result` | { username: string, password: string, code?: string } | { token: string, identity: object, … } | 401 invalid credentials | portable | no |
| `authn.identifyUser` | Identify the caller if a valid token is present; a state-changing request authenticated by the session cookie must come from the same origin | – | `token?`, `identity?` | – | – | 403 a state-changing request authenticated by the session cookie is not from the same origin | portable | no |
| `authn.requireUser` | Require a valid session; a state-changing request authenticated by the session cookie must come from the same origin | – | `token`, `identity` | – | – | 401 not authenticated; 403 a state-changing request authenticated by the session cookie is not from the same origin | portable | no |
| `authn.loadIdentity` | Current identity | `identity` | `result` | – | { id: string, claims: object, … } | 401 not authenticated | portable | no |
| `authn.logout` | End the current session and remove the session cookie | `token` | `responseHeaders`, `result` | – | { ok: boolean, … } | 401 not authenticated | portable | no |

<!-- kestrel-docs:end -->
