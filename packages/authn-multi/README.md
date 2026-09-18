# authn/multi
`authn@1` with users and sessions in `persistence@1` (`authn_users`, `authn_sessions`) – sessions
survive restarts. Passwords are scrypt hashes; `bootstrap` creates the first user when the user
collection is empty so a fresh install is not locked out. Identity claims: `{ username, roles }`.
Config: `identifier` (`username` | `email` – the credential field), `minPasswordLength`,
`sessionTtlSeconds`, `bootstrap { username, passwordHash, roles }`.

Every step returns a `Result`; `authn@1`'s own `login`/`resolve`/`logout` only ever answer
`Err(TRANSIENT)` (wrong credentials are `Ok(null)`). `createUser`, `setPassword`, `changePassword`,
`setActive`, `getUser`, `listUsers` and `cleanupSessions` beyond the contract can additionally
answer `VALIDATION`, `CONFLICT` or `NOT_FOUND`; a duplicate username is `CONFLICT` (409).

| Step | reads | writes | errors |
|---|---|---|---|
| `authn.login` | – | `token`, `identity`, `result` | `UNAUTHENTICATED`, `TRANSIENT` |
| `authn.identifyUser` | – | `token?`, `identity?` | `TRANSIENT` |
| `authn.requireUser` | – | `token`, `identity` | `UNAUTHENTICATED`, `TRANSIENT` |
| `authn.loadIdentity` | `identity` | `result` | `UNAUTHENTICATED` |
| `authn.logout` | `token` | `result` | `UNAUTHENTICATED`, `TRANSIENT` |
| `authn.createUser` | – | `result` | `VALIDATION`, `CONFLICT`, `TRANSIENT` |
| `authn.listUsers` | – | `result` | `TRANSIENT` |
| `authn.getUser` | `params.id` | `result` | `NOT_FOUND`, `TRANSIENT` |
| `authn.setPassword` | `params.id` | `result` | `VALIDATION`, `NOT_FOUND`, `TRANSIENT` |
| `authn.changePassword` | `identity` | `result` | `VALIDATION`, `UNAUTHENTICATED`, `TRANSIENT` |
| `authn.deactivateUser` | `params.id` | `result` | `VALIDATION` (self), `NOT_FOUND`, `TRANSIENT` |
| `authn.activateUser` | `params.id` | `result` | `NOT_FOUND`, `TRANSIENT` |
| `authn.cleanupSessions` | – | `result` | `TRANSIENT` |

Not included: self-service registration, password reset by mail, login rate limiting (pipeline concerns).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authn-multi` – module `authn/multi`: provides `authn@1`; requires `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `identifier` | enum | no | `"username"` |
| `minPasswordLength` | integer | no | `12` |
| `sessionTtlSeconds` | integer | no | `86400` |
| `bootstrap` | object | no | – |
| `bootstrap.username` | string | no | – |
| `bootstrap.passwordHash` | string | no | *(secret)* |
| `bootstrap.roles` | array | no | `[]` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `authn.login` | Log in with credentials | – | `token`, `identity`, `result` | { username?: string, email?: string, password: string } | { token: string, identity: object, … } | 401 invalid credentials |
| `authn.identifyUser` | Identify the caller if a valid token is present | – | `token?`, `identity?` | – | – | – |
| `authn.requireUser` | Require a valid session | – | `token`, `identity` | – | – | 401 not authenticated |
| `authn.loadIdentity` | Current identity | `identity` | `result` | – | { id: string, claims: object, … } | 401 not authenticated |
| `authn.logout` | End the current session | `token` | `result` | – | { ok: boolean, … } | 401 not authenticated |
| `authn.createUser` | Create a user | – | `result` | { username: string, password: string, roles?: string[] } | { id: string, username: string, roles: string[], active: boolean, createdAt: number, … } | 400 invalid input; 409 username already exists |
| `authn.listUsers` | List users | – | `result` | – | object[] | – |
| `authn.getUser` | One user | `params.id` | `result` | – | { id: string, username: string, roles: string[], active: boolean, createdAt: number, … } | 404 user not found |
| `authn.setPassword` | Set a user's password (ends their sessions) | `params.id` | `result` | { password: string } | { ok: boolean, … } | 400 password missing or too short; 404 user not found |
| `authn.changePassword` | Change own password | `identity` | `result` | { currentPassword: string, newPassword: string } | { ok: boolean, … } | 400 wrong current password, missing fields, or new one too short; 401 not authenticated |
| `authn.deactivateUser` | Deactivate a user | `params.id` | `result` | – | { ok: boolean, … } | 400 cannot deactivate yourself; 404 user not found |
| `authn.activateUser` | Activate a user | `params.id` | `result` | – | { ok: boolean, … } | 404 user not found |
| `authn.cleanupSessions` | Remove expired sessions | – | `result` | – | { removed?: number, … } | – |

Used by 60 of 69 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
