# audit/persistence
Writes one entry per event (`eventId`, `event`, `at`, `identityId`, `ip`, `params`) into the collection
`audit_entries`; `ip` is the client address the emitting run had, and the event's `id` (the document
or user it is about) lands in `params.id` when the route had none. Provides no contract, only the steps `audit.record`, `audit.anonymize` and
`audit.prune`, meant for pipelines started by an event or a cron trigger. Results and payloads of
the originating pipeline are never stored. Requires `persistence@1`.

**Personal data.** An entry names a user by id: `identityId` (who acted) and any param that
carries a user id (who was acted upon); no token, no body. The only name is the attempted username of a
sign-in entry (see below). `audit.anonymize` removes them for one user — `identityId` becomes `null` and
every param holding their id is dropped, and in a run started by an event the `username` param of every
entry that holds the login name in `payload.result.username` goes too, as `authn.deleteUser` reports it
in its result and `events.emit:user.deleted?with=result` carries it. The event, its time and the other
params stay, so the log keeps telling that something happened without telling who. An
entry is never moved to another user: a login belongs to nobody else. Run it from a pipeline on
`user.deleted`; it is idempotent, so a failed run can simply be repeated from an admin route. That
route must run `authn.requireAbsentUser` first: the step acts on whatever id it is given, so on an
existing user it would erase their trail, and it refuses an id that is not a UUID, the form of every `authn-multi` user id, with 400. Emit an event after the step and record it with
`audit.recordActor`, which keeps the caller, the event and its time but not the params and id that name the
user, to leave a trace of who ran the repair without undoing the anonymisation. A run from such a route
works by id only and leaves login names alone: a name in its body would prove nothing about whose it is.

**Security entries.** With `securityEvents` (default on) the module watches every HTTP run and records,
without any pipeline: `auth.failed` when one of `failedSteps` failed (default: `authn.login`,
`authn.confirmPassword`, `authn.changePassword`, `mfa.check`, `mfa.startSetup`), with the attempted
`username` when the step reported one; `auth.secondFactorRequested`, with the same params, when such a step
only asks for the next part of a sign-in after a correct password: a second-factor code
(`SECOND_FACTOR_REQUIRED`), its setup (`SECOND_FACTOR_SETUP_REQUIRED`) or an enrollment code the request did
not carry (`ENROLLMENT_CODE_REQUIRED` with `details.enrollmentCodeGiven: false`), so a sign-in with a second
factor leaves no `auth.failed`, while a wrong code or a wrong enrollment code does;
`access.denied` for a 403 and `access.rateLimited` for a 429, each at most once a minute per
address, identity, pipeline and step — the entry after a quiet minute says in `params.suppressed` how
many it left out. Each carries `at`, `ip`, the `identityId` known when the run ended and `params`
`{ pipeline, step, code }`; never a body, a password or a token. The attempted username of a failed
sign-in is kept as sent — at most 256 characters, control characters replaced by spaces; it may
name nobody. `audit.anonymize` removes it when it equals the deleted user's login name, compared in that
same form and case-sensitively, as `authn-multi` looks a user up; other spellings, names the user had
before a rename and names of nobody stay until retention removes them.

**Retention.** `retentionDays` (no default) is how long an entry is kept. `audit.prune` deletes
everything older than that and reports `{ removed }`; without the config key it fails 400, because
a prune with no rule would silently keep everything. Wire it to a cron trigger.

An event redelivered with the same `eventId` is skipped: `record` looks the id up before inserting.
`persistence@1` has no unique constraint, so the check is a read followed by a write — two
concurrent deliveries of the same event can still both pass it. Events without an `eventId` are
always inserted. `audit.record` fails `TRANSIENT` (503, retryable) when the persistence backend is
unavailable; it never fails otherwise.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-audit-persistence` – module `audit/persistence`: provides no contract; requires `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `retentionDays` | integer | no | – |
| `securityEvents` | boolean | no | `true` |
| `failedSteps` | array | no | `["authn.login","authn.confirmPassword","authn.changePassword","mfa.check","mfa.startSetup"]` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `audit.record` | Persist an audit log entry for an emitted event | `payload` | – | object | – | – | – | no |
| `audit.recordActor` | Persist an audit log entry for an emitted event with its caller and address but without its params and id, so it names no one the event was about | `payload` | – | object | – | – | – | no |
| `audit.anonymize` | Strip the user in `params.id` or the event payload's `id` from every audit entry: their identity id and every param holding it go, and in a run started by an event also the login name in `payload.result.username` from sign-in entries; the event, its time and the other params stay | `params.id`, `payload` | `result` | object | { entries: number, … } | 400 no user id, or an id that is not a UUID | – | no |
| `audit.prune` | Remove every audit entry older than the configured `retentionDays` | – | `result` | – | { removed: number, … } | 400 no `retentionDays` configured | – | no |

Pipelines in `examples/minimal` using these steps:

- **anonymizeAuditUser** (event user.deleted): **`audit.anonymize`**
- **auditAuth** (event auth.loggedIn, event auth.loggedOut): **`audit.record`**
- **auditUsers** (event user.auditAnonymizeRetried, event user.revisionsReassignRetried): **`audit.recordActor`**
- **pruneAudit** (cron 45 3 * * *): **`audit.prune`**
- **retryAnonymizeAuditUser** (POST /admin/users/:id/audit/anonymize): `authn.requireUser` → `authz.requireRole` → `authz.require:users.manage` → `authn.requireAbsentUser` → **`audit.anonymize`** → `events.emit:user.auditAnonymizeRetried` → `events.relay`

<!-- kestrel-docs:end -->
