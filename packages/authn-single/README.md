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

Generate a hash: `node -e "import('./modules/authn/single/impl.ts').then(m => console.log(m.hashPassword(process.argv[1])))" -- <password>`
Not included: multiple users, persistence of sessions across restarts, password change.
