# authn/single
One user from config (`username`, scrypt `passwordHash`, `roles` → `claims.roles`), sessions held in memory with a TTL.
Needs no other contract.

Every step returns a `Result`; the in-memory implementation never answers `TRANSIENT`, so the only
client-visible failure is `UNAUTHENTICATED` (401). `authn.loadIdentity` and `authn.logout` expect a
pipeline that runs `authn.requireUser` first (boot's dataflow check enforces it) and answer
`UNAUTHENTICATED` when identity or token is missing anyway.

| Step | reads | writes | errors |
|---|---|---|---|
| `authn.login` | – | `token`, `identity`, `result` | `UNAUTHENTICATED` |
| `authn.identifyUser` | – | `token?`, `identity?` | – |
| `authn.requireUser` | – | `token`, `identity` | `UNAUTHENTICATED` |
| `authn.loadIdentity` | `identity` | `result` | `UNAUTHENTICATED` |
| `authn.logout` | `token` | `result` | `UNAUTHENTICATED` |

Generate a hash: `node -e "import('@michaelthielemann/kestrel-authn-single/impl').then(m => console.log(m.hashPassword(process.argv[1])))" -- <password>`
Not included: multiple users, persistence of sessions across restarts, password change.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authn-single` – module `authn/single`: provides `authn@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `username` | string | yes | – |
| `passwordHash` | string | yes | *(secret)* |
| `sessionTtlSeconds` | integer | no | `86400` |
| `roles` | array | no | `[]` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `authn.login` | Log in with credentials | – | `token`, `identity`, `result` | { username: string, password: string } | { token: string, identity: object, … } | 401 invalid credentials |
| `authn.identifyUser` | Identify the caller if a valid token is present | – | `token?`, `identity?` | – | – | – |
| `authn.requireUser` | Require a valid session | – | `token`, `identity` | – | – | 401 not authenticated |
| `authn.loadIdentity` | Current identity | `identity` | `result` | – | { id: string, claims: object, … } | 401 not authenticated |
| `authn.logout` | End the current session | `token` | `result` | – | { ok: boolean, … } | 401 not authenticated |

<!-- kestrel-docs:end -->
