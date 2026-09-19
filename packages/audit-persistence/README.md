# audit/persistence
Writes one entry per event (`eventId`, `event`, `at`, `identityId`, `params`) into the collection
`audit_entries`. Provides no contract, only the steps `audit.record`, `audit.anonymize` and
`audit.prune`, meant for pipelines started by an event or a cron trigger. Results and payloads of
the originating pipeline are never stored. Requires `persistence@1`.

**Personal data.** An entry names a user only by id: `identityId` (who acted) and any param that
carries a user id (who was acted upon); no username, no token, no body. `audit.anonymize` removes
both for one user — `identityId` becomes `null` and every param naming them is dropped, while the
event and its time stay, so the log keeps telling that something happened without telling who. An
entry is never moved to another user: a login belongs to nobody else. Run it from a pipeline on
`user.deleted`; it is idempotent, so a failed run can simply be repeated from an admin route.

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

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `audit.record` | Persist an audit log entry for an emitted event | `payload` | – | object | – | – |
| `audit.anonymize` | Strip the user in `params.id` or the event payload's `id` from every audit entry: their identity id and every param naming them go, the event and its time stay | `params.id`, `payload` | `result` | object | { entries: number, … } | 400 no user id |
| `audit.prune` | Remove every audit entry older than the configured `retentionDays` | – | `result` | – | { removed: number, … } | 400 no `retentionDays` configured |

Pipelines in `examples/minimal` using these steps:

- **anonymizeAuditUser** (event user.deleted): **`audit.anonymize`**
- **auditAuth** (event auth.loggedIn, event auth.loggedOut): **`audit.record`**
- **pruneAudit** (cron 45 3 * * *): **`audit.prune`**
- **retryAnonymizeAuditUser** (POST /admin/users/:id/audit/anonymize): `authn.requireUser` → `authz.require:users.manage` → **`audit.anonymize`**

<!-- kestrel-docs:end -->
