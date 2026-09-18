# authn/multi
`authn@1` with users and sessions in `persistence@1` (`authn_users`, `authn_sessions`) – sessions
survive restarts. Passwords are scrypt hashes; `bootstrap` creates the first user when the user
collection is empty so a fresh install is not locked out. Identity claims: `{ username, roles }`.
Config: `identifier` (`username` | `email` – the credential field), `minPasswordLength`,
`sessionTtlSeconds`, `adminPermission`, `bootstrap { username, passwordHash, roles }`.

The username is the identity – there is no e-mail field on a user. Roles are plain strings: the
module never learns which ones a site defines, because `authz@1` maps roles to permissions and
answers questions about one identity only. What it can ask is whether a user still holds
`adminPermission` (default `users.manage`), and it does so through the optional `authz@1`
dependency before every change that could remove the last one: deactivating, deleting or taking
the permission away from the last active holder is `LAST_ADMIN` (409). Without an authz module
nobody is known to be an admin and the guard stays silent.

Every step returns a `Result`; `authn@1`'s own `login`/`resolve`/`logout` only ever answer
`Err(TRANSIENT)` (wrong credentials are `Ok(null)`). `createUser`, `setPassword`, `changePassword`,
`setActive`, `updateUser`, `deleteUser`, `getUser`, `listUsers` and `cleanupSessions` beyond the
contract can additionally answer `VALIDATION`, `CONFLICT`, `NOT_FOUND` or `LAST_ADMIN`; a duplicate
username is `CONFLICT` (409), the last admin guard is `LAST_ADMIN` (409).

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
| `authn.updateUser` | `params.id` | `result` | `VALIDATION`, `CONFLICT`, `NOT_FOUND`, `LAST_ADMIN`, `TRANSIENT` |
| `authn.deleteUser` | `identity`, `params.id` | `result` | `VALIDATION` (self), `NOT_FOUND`, `LAST_ADMIN`, `TRANSIENT` |
| `authn.setPassword` | `params.id` | `result` | `VALIDATION`, `NOT_FOUND`, `TRANSIENT` |
| `authn.changePassword` | `identity` | `result` | `VALIDATION`, `UNAUTHENTICATED`, `TRANSIENT` |
| `authn.deactivateUser` | `params.id` | `result` | `VALIDATION` (self), `NOT_FOUND`, `LAST_ADMIN`, `TRANSIENT` |
| `authn.activateUser` | `params.id` | `result` | `NOT_FOUND`, `TRANSIENT` |
| `authn.cleanupSessions` | – | `result` | `TRANSIENT` |

Not included: self-service registration, password reset by mail, login rate limiting (pipeline
concerns), an e-mail field (a model change with its own use, its own ticket).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authn-multi` – module `authn/multi`: provides `authn@1`; requires `persistence@1`; optional `authz@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `identifier` | enum | no | `"username"` |
| `minPasswordLength` | integer | no | `12` |
| `sessionTtlSeconds` | integer | no | `86400` |
| `adminPermission` | string | no | `"users.manage"` |
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
| `authn.updateUser` | Rename a user or set their roles (a role change ends their sessions) | `params.id` | `result` | { username?: string, roles?: string[] } | { id: string, username: string, roles: string[], active: boolean, createdAt: number, … } | 400 neither username nor roles given, or an empty one; 404 user not found; 409 username already exists (`CONFLICT`), or the last active admin would lose the admin permission (`LAST_ADMIN`) |
| `authn.deleteUser` | Delete a user and their sessions for good | `identity`, `params.id` | `result` | – | { ok: boolean, … } | 400 cannot delete yourself; 404 user not found; 409 the last active admin cannot be deleted (`LAST_ADMIN`) |
| `authn.setPassword` | Set a user's password (ends their sessions) | `params.id` | `result` | { password: string } | { ok: boolean, … } | 400 password missing or too short; 404 user not found |
| `authn.changePassword` | Change own password | `identity` | `result` | { currentPassword: string, newPassword: string } | { ok: boolean, … } | 400 wrong current password, missing fields, or new one too short; 401 not authenticated |
| `authn.deactivateUser` | Deactivate a user (ends their sessions) | `params.id` | `result` | – | { ok: boolean, … } | 400 cannot deactivate yourself; 404 user not found; 409 the last active admin cannot be deactivated (`LAST_ADMIN`) |
| `authn.activateUser` | Activate a user | `params.id` | `result` | – | { ok: boolean, … } | 404 user not found |
| `authn.cleanupSessions` | Remove expired sessions | – | `result` | – | { removed?: number, … } | – |

Used by 62 of 71 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
