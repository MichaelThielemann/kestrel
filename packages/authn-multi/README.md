# authn/multi
`authn@1` with users and sessions in `persistence@1` (`authn_users`, `authn_sessions`) – sessions
survive restarts. Passwords are scrypt hashes; a session row is keyed by the SHA-256 digest of its
token, never the token itself, so a copy of the database (a replica, a backup) holds no token that
signs anyone in. It does hold the password hashes: keep those copies as private as the database.
`bootstrap` creates the first user when the user collection is empty so a fresh install is not
locked out. Identity claims: `{ username, roles }`.
Config: `identifier` (`username` | `email` – the credential field), `minPasswordLength`,
`sessionTtlSeconds`, `secureCookie`, `adminPermission`, `bootstrap { username, passwordHash, roles }`.

The username is the identity – there is no e-mail field on a user. Roles are plain strings: the
module never learns which ones a site defines, because `authz@1` maps roles to permissions and
answers questions about one identity only. What it can ask is whether a user still holds
`adminPermission` (default `users.manage`), and it does so through the optional `authz@1`
dependency before every change that could remove the last one: deactivating, deleting or taking
the permission away from the last active holder is `LAST_ADMIN` (409). Without an authz module
nobody is known to be an admin and the guard stays silent.

`updateUser`, `deactivateUser` and `deleteUser` are `atomicSafe`. The guard reads the other admins
and then writes, so two requests that each remove the other's admin permission only serialise
when the pipeline runs the step in an atomic group, as `examples/minimal` does
(`{ atomic: ["authn.deactivateUser"] }`): the second request then sees the first one's result and
answers `LAST_ADMIN`.

**Password checks.** Login and `changePassword` derive the scrypt key on the libuv thread pool
(`verifyPasswordAsync`), so a login never stalls other requests. An unknown or deactivated username is
checked against a throwaway hash made at start with the same parameters, so the answer takes as long
as for a real user with a wrong password. The pool has four threads unless `UV_THREADPOOL_SIZE` says
otherwise, and image processing shares it; raise it on a busy instance. `verifyPassword` stays the
synchronous form for scripts.

**Failed logins.** `authn.login` answers 401 with `details.username`, the name that was tried, so
an observer such as `audit-persistence` can record it; the password is never repeated anywhere. A
`username` or `email` longer than 320 characters is refused with 400 before it is looked up.

**Browser sessions.** `authn.login` answers the token in the body, for a client that sends it as
`Authorization: Bearer`, and sets it as the `__Host-kestrel_token` cookie (`HttpOnly`, `Secure`,
`SameSite=Strict`, `Path=/`, `Max-Age` = `sessionTtlSeconds`), so a browser holds a session page
script cannot read and a sibling origin cannot overwrite; `authn.logout` removes the cookie.
`secureCookie: false` drops `Secure` and the prefix (the cookie is then `kestrel_token`), for
signing in over plain HTTP during development only. A `POST`/`PUT`/`PATCH`/`DELETE` authenticated
by the cookie rather than a bearer token must come from the same origin (`Sec-Fetch-Site:
same-origin`, or an `Origin` matching `Host`); otherwise `authn.identifyUser` and
`authn.requireUser` answer `FORBIDDEN` (403).

Every step returns a `Result`; `authn@1`'s own `login`/`resolve`/`logout` only ever answer
`Err(TRANSIENT)` (wrong credentials are `Ok(null)`). `createUser`, `setPassword`, `changePassword`,
`setActive`, `updateUser`, `deleteUser`, `getUser`, `listUsers` and `cleanupSessions` beyond the
contract can additionally answer `VALIDATION`, `CONFLICT`, `NOT_FOUND` or `LAST_ADMIN`; a duplicate
username is `CONFLICT` (409), the last admin guard is `LAST_ADMIN` (409).

| Step | reads | writes | errors |
|---|---|---|---|
| `authn.login` | – | `token`, `identity`, `responseHeaders`, `result` | `UNAUTHENTICATED`, `TRANSIENT` |
| `authn.identifyUser` | – | `token?`, `identity?` | `FORBIDDEN`, `TRANSIENT` |
| `authn.requireUser` | – | `token`, `identity` | `UNAUTHENTICATED`, `FORBIDDEN`, `TRANSIENT` |
| `authn.loadIdentity` | `identity` | `result` | `UNAUTHENTICATED` |
| `authn.logout` | `token` | `responseHeaders`, `result` | `UNAUTHENTICATED`, `TRANSIENT` |
| `authn.createUser` | – | `result` | `VALIDATION`, `CONFLICT`, `TRANSIENT` |
| `authn.listUsers` | – | `result` | `TRANSIENT` |
| `authn.getUser` | `params.id` | `result` | `NOT_FOUND`, `TRANSIENT` |
| `authn.updateUser` | `params.id` | `result` | `VALIDATION`, `CONFLICT`, `NOT_FOUND`, `LAST_ADMIN`, `TRANSIENT` |
| `authn.deleteUser` | `identity`, `params.id`, `payload.reassignTo` | `result` | `VALIDATION` (self, bad target), `NOT_FOUND`, `LAST_ADMIN`, `TRANSIENT` |
| `authn.setPassword` | `params.id` | `result` | `VALIDATION`, `NOT_FOUND`, `TRANSIENT` |
| `authn.changePassword` | `identity` | `result` | `VALIDATION`, `UNAUTHENTICATED`, `TRANSIENT` |
| `authn.deactivateUser` | `params.id` | `result` | `VALIDATION` (self), `NOT_FOUND`, `LAST_ADMIN`, `TRANSIENT` |
| `authn.activateUser` | `params.id` | `result` | `NOT_FOUND`, `TRANSIENT` |
| `authn.cleanupSessions` | – | `result` | `TRANSIENT` |
| `authn.endSessions` | `params.id` | `result` | `TRANSIENT` |
| `authn.requireRecentAuth:<seconds>` | `token` | – | `UNAUTHENTICATED`, `REAUTH_REQUIRED`, `TRANSIENT` |
| `authn.confirmPassword` | `token` | `result` | `VALIDATION`, `UNAUTHENTICATED`, `TRANSIENT` |

**Recent authentication.** A session remembers when its password was last checked: at login, on
`changePassword` for the session that made the change, and through `authn.confirmPassword`
(`{ password }`, 400 when it is wrong). Put `authn.requireRecentAuth:<seconds>` after
`authn.requireUser` in front of an action that must not ride on a stolen or forgotten session —
creating, changing, deactivating or deleting users, setting a password, restoring a backup: when the
last check is older than the window it answers `403 REAUTH_REQUIRED` with `details.maxAgeSeconds`,
and the client asks for the password, calls the confirming pipeline and repeats the action.
Rate-limit that pipeline like the login. `authn.setPassword` refuses the caller's own account (400);
one's own password changes only through `changePassword`, which needs the current one.

**Deleting and the authored history.** `authn.deleteUser` takes an optional `reassignTo` in the
body: the id of an existing, active user who is not the one being deleted. An unknown id is 404, an
inactive one, the deleted user themselves or a value that is not a string is 400 — and in each case
the user stays. On success the step answers `{ ok: true, reassignTo: { id, name } | null }`, `name`
being the target's username at that moment. Emit the event with `events.emit:user.deleted?with=result`
so the target travels in the payload, and let the pipelines behind that event decide what happens to
what the user wrote: `revisions.reassignAuthor` moves or anonymises their revisions,
`audit.anonymize` strips them from the audit log. The module itself deletes only the user row and
their sessions; it knows nothing about revisions or audit entries.

Not included: self-service registration, password reset by mail, login rate limiting (pipeline
concerns), an e-mail field.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authn-multi` – module `authn/multi`: provides `authn@1`; requires `persistence@1`; optional `authz@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `identifier` | enum | no | `"username"` |
| `minPasswordLength` | integer | no | `12` |
| `sessionTtlSeconds` | integer | no | `86400` |
| `secureCookie` | boolean | no | `true` |
| `adminPermission` | string | no | `"users.manage"` |
| `bootstrap` | object | no | – |
| `bootstrap.username` | string | no | – |
| `bootstrap.passwordHash` | string | no | *(secret)* |
| `bootstrap.roles` | array | no | `[]` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `authn.login` | Log in with credentials; the token comes back in the body and in an HttpOnly session cookie | – | `token`, `identity`, `responseHeaders`, `result` | { username?: string, email?: string, password: string, code?: string } | { token: string, identity: object, … } | 401 invalid credentials | portable | no |
| `authn.identifyUser` | Identify the caller if a valid token is present; a state-changing request authenticated by the session cookie must come from the same origin | – | `token?`, `identity?` | – | – | 403 a state-changing request authenticated by the session cookie is not from the same origin | portable | no |
| `authn.requireUser` | Require a valid session; a state-changing request authenticated by the session cookie must come from the same origin | – | `token`, `identity` | – | – | 401 not authenticated; 403 a state-changing request authenticated by the session cookie is not from the same origin | portable | no |
| `authn.loadIdentity` | Current identity | `identity` | `result` | – | { id: string, claims: object, … } | 401 not authenticated | portable | no |
| `authn.logout` | End the current session and remove the session cookie | `token` | `responseHeaders`, `result` | – | { ok: boolean, … } | 401 not authenticated | portable | no |
| `authn.verifyUser:<arg>` | Verify the user reference at payload.<arg>: it must be a user id, { id }, or null. Writes its canonical { id, name } to verifiedUser, or null when there was none to verify. authn.verifyUser:reassignTo reads payload.reassignTo; authn.verifyUser:result.reassignTo reads payload.result.reassignTo, the shape an event hands over | `payload.<arg>` | `verifiedUser` | { <arg>?: string \| object \| null, … } | – | 400 the value is neither a user id, { id } nor null, or the user is not active; 404 user not found | beside | yes |
| `authn.requireAbsentUser` | Require that params.id is the id of no user, active or not; the guard of the routes that clean up after a deleted user. An id that has the shape of no user id (a UUID) is refused | `params.id` | – | – | – | 400 params.id is not a user id; 409 the user still exists | beside | yes |
| `authn.createUser` | Create a user | – | `result` | { username: string, password: string, roles?: string[] } | { id: string, username: string, roles: string[], active: boolean, createdAt: number, … } | 400 invalid input; 409 username already exists | beside | no |
| `authn.listUsers` | List users | – | `result` | – | object[] | – | beside | no |
| `authn.getUser` | One user | `params.id` | `result` | – | { id: string, username: string, roles: string[], active: boolean, createdAt: number, … } | 404 user not found | beside | no |
| `authn.updateUser` | Rename a user or set their roles (a role change ends their sessions) | `params.id` | `result` | { username?: string, roles?: string[] } | { id: string, username: string, roles: string[], active: boolean, createdAt: number, … } | 400 neither username nor roles given, or an empty one; 404 user not found; 409 username already exists (`CONFLICT`), or the last active admin would lose the admin permission (`LAST_ADMIN`) | beside | yes |
| `authn.deleteUser` | Delete a user and their sessions for good; `reassignTo` names the active user their authored history moves to, without it the history is anonymised | `identity`, `params.id`, `payload.reassignTo` | `result` | { reassignTo?: string \| null } | { ok: boolean, reassignTo: object \| null, … } | 400 cannot delete yourself, or a `reassignTo` that is the deleted user, inactive or not a user id; 404 user not found, or `reassignTo` names no user; 409 the last active admin cannot be deleted (`LAST_ADMIN`) | beside | yes |
| `authn.setPassword` | Set another user's password (ends their sessions); one's own password changes only through changePassword | `identity?`, `params.id` | `result` | { password: string } | { ok: boolean, … } | 400 password missing or too short, or the caller's own account; 404 user not found | beside | no |
| `authn.changePassword` | Change own password | `identity` | `result` | { currentPassword: string, newPassword: string } | { ok: boolean, … } | 400 wrong current password, missing fields, or new one too short; 401 not authenticated | beside | no |
| `authn.deactivateUser` | Deactivate a user (ends their sessions) | `params.id` | `result` | – | { ok: boolean, … } | 400 cannot deactivate yourself; 404 user not found; 409 the last active admin cannot be deactivated (`LAST_ADMIN`) | beside | yes |
| `authn.activateUser` | Activate a user | `params.id` | `result` | – | { ok: boolean, … } | 404 user not found | beside | no |
| `authn.cleanupSessions` | Remove expired sessions | – | `result` | – | { removed: number, … } | – | beside | no |
| `authn.endSessions` | End every session of the user in params.id, e.g. after its second factor was reset | `params.id` | `result` | – | { ok: boolean, … } | – | beside | no |
| `authn.requireRecentAuth:<arg>` | Require that the session's password was checked within the last <arg> seconds, at login or through authn.confirmPassword; otherwise 403 REAUTH_REQUIRED | `token` | – | – | – | 401 not authenticated; 403 the last password check is older than the window (`REAUTH_REQUIRED`) | beside | no |
| `authn.confirmPassword` | Confirm the caller's password; marks the session as freshly authenticated for authn.requireRecentAuth | `token` | `result` | { password: string } | { ok: boolean, … } | 400 the password is missing or wrong; 401 not authenticated | beside | no |

Used by 86 of 111 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
