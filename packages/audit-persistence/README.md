# audit/persistence
Writes one entry per event (`eventId`, `event`, `at`, `identityId`, `params`) into the collection
`audit_entries`. Provides no contract, only the step `audit.record`, meant for pipelines started
by an event trigger. Results and payloads of the originating pipeline are never stored.
Requires `persistence@1`.

An event redelivered with the same `eventId` is skipped: `record` looks the id up before inserting.
`persistence@1` has no unique constraint, so the check is a read followed by a write — two
concurrent deliveries of the same event can still both pass it. Events without an `eventId` are
always inserted. `audit.record` fails `TRANSIENT` (503, retryable) when the persistence backend is
unavailable; it never fails otherwise.
