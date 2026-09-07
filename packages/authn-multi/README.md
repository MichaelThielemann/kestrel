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
