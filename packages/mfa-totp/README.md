# mfa/totp
A second factor for any `authn@1` module: time-based one-time codes (RFC 6238: HMAC-SHA-1, 30 seconds, six
digits) with recovery codes, in its own collection `mfa_factors` via `persistence@1`. It provides no contract;
it needs `authn@1` (to check a password and to end a session) and uses `authz@1` when `enforce` names
permissions. With `authn-multi` it meets the multi-factor requirement for an admin sign-in; the users,
passwords and sessions stay where they are, so adding the module needs no data migration.

**Signing in.** Put `mfa.check` right after `authn.login`; the login body carries the code as `code` (both
authn modules accept it and leave it to this step). An account with a confirmed factor must send a code —
without one the step answers 401 `SECOND_FACTOR_REQUIRED`, with a wrong or already used one 401
`UNAUTHENTICATED`. An account without one, when `enforce` requires it, gets 401
`SECOND_FACTOR_SETUP_REQUIRED` and **no session**: every refusal ends the session `authn.login` opened
(`authn@1.logout`), and a failed run sends no cookie. Each refusal carries `details.username` for an
audit log, never the code.

**Setting up.** `mfa.startSetup` takes the same `{ username | email, password }` as a login, checks them
through `authn@1` (closing the session that opens right away) and answers `{ secret, uri }` — the base32
secret and its `otpauth://` URI for an authenticator app. A second call before confirming replaces the
secret; an account with a confirmed factor gets 409. The next login with a code for the new secret confirms
it and adds `result.recoveryCodes` to the login answer, once: ten codes of 25 base32 characters
(`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`, 125 bits), each good for one sign-in in place of a time-based code.
Setting up needs only the password: whoever knows it when an account has no confirmed factor — after the
module is added, or after a reset — binds the first device. Add the module to an installation whose
passwords are sound, and reset a factor only when its owner is about to set up the new one.

**What is stored.** The secret is sealed with AES-256-GCM under `secretKey` (32 bytes, 64 hex digits or 43
base64url characters, kept outside the database), so a copy of the database holds no usable secret.
Recovery codes are stored only as HMAC-SHA-256 digests under a key derived from `secretKey`, so a copy of
the database gives nothing to compute. A code is accepted for the current time step and one on either side,
and never twice: the last accepted step is kept per account, and every change to a factor is conditional on
the version it read, so two requests with the same code cannot both pass.

**Wrong codes.** After `maxFailures` (default 10) wrong codes in a row the factor is locked for
`lockSeconds` (default 900); every further lock lasts twice as long, at most a day. While it is locked,
`mfa.check` answers 429 `RATE_LIMITED` with `details.retryAfterSeconds`, even for the right code. The count
lives in `mfa_factors`, so it survives a restart and holds without any rate-limit module; a correct code
clears it, and so does a reset.

**Resetting.** `mfa.reset` (`params.id`) removes another user's factor — not the caller's own (400); a user
who lost the device signs in with a recovery code. Follow it with a step that ends that user's sessions,
e.g. `authn-multi`'s `authn.endSessions`. `mfa.forget` removes the factor of a deleted user (event
`user.deleted`). `mfa.listEnrolled` answers the ids of the users with a confirmed factor.

Config: `issuer` (the name an app shows, default `Kestrel`), `secretKey` (required, secret), `enforce`
(`"all"` default, `"none"`, or `{ permissions: [...] }` for the accounts holding one of them),
`recoveryCodes` (default 10), `maxFailures` (default 10), `lockSeconds` (default 900).

Throttle the login and the setup pipeline per address and per account (`ratelimit-memory`); a wrong code
costs a correct password first. Not included: WebAuthn, new recovery codes on request, setting a factor up
from a running session.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-mfa-totp` – module `mfa/totp`: provides no contract; requires `persistence@1`, `authn@1`; optional `authz@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `issuer` | string | no | `"Kestrel"` |
| `secretKey` | string | yes | *(secret)* |
| `enforce` | union | no | `"all"` |
| `recoveryCodes` | integer | no | `10` |
| `maxFailures` | integer | no | `10` |
| `lockSeconds` | integer | no | `900` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `mfa.check` | After authn.login: check the second factor with payload.code (a time-based or a recovery code). A refusal ends the session the login opened; a code that confirms a new factor adds result.recoveryCodes, shown once | `identity`, `token` | `result?` | { code?: string, … } | { recoveryCodes?: string[], … } | 401 the code is wrong or used (`UNAUTHENTICATED`), a code is needed (`SECOND_FACTOR_REQUIRED`), or the account must set up a second factor first (`SECOND_FACTOR_SETUP_REQUIRED`); 429 too many wrong codes in a row; the factor is locked for a while (`RATE_LIMITED`) | – | no |
| `mfa.startSetup` | Check the password through authn@1 and start setting up a second factor: answers the new secret and its otpauth URI to the caller it identified; the next login with a code for it confirms it | – | `identity`, `result` | { username?: string, email?: string, password: string } | { secret: string, uri: string, … } | 401 invalid credentials; 409 the account already has a second factor | – | no |
| `mfa.reset` | Remove another user's second factor; follow it with a step that ends that user's sessions | `identity?`, `params.id` | `result` | – | { ok: boolean, … } | 400 the caller's own account | – | no |
| `mfa.forget` | Remove the second factor of the user in params.id or the event payload's id, e.g. on user.deleted | `params.id?`, `payload.id?` | – | { id?: string \| null, … } | – | 400 no user id | – | no |
| `mfa.listEnrolled` | The ids of the users with a confirmed second factor | – | `result` | – | string[] | – | – | no |

<!-- kestrel-docs:end -->
