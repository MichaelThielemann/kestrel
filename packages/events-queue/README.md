# events/queue
`events@1` with a persistent queue: `emit` writes one row per event to `events_queue` (via
`persistence@1`) and returns; an in-process worker claims due rows every `pollMs`, runs every
handler with a frozen copy of the payload and marks the row `done`. A failing handler counts an
attempt and requeues the row after `backoffSeconds[attempt - 1]` (the last entry repeats); after
`maxAttempts` failures the row is `dead` with the last error. A row stuck in `running` longer than
`lockTtlSeconds` (a crashed process) is picked up again. Delivery is therefore at least once, with
no ordering guarantee across events — listener pipelines must be idempotent. The triggering
pipeline no longer waits for listeners; a listener pipeline ending with a failure status counts as
a failed attempt. `emit` rejects only when the row cannot be written, and the `events.emit` step
then fails the run with the persistence error (503 `TRANSIENT`) instead of dropping the event.
Alternative to `events-inmemory` (same steps, same envelope, same `triggers.event` hook); configure
one of the two, never both. The worker starts with the event triggers in `start()` and stops on
`stop()`; without any event trigger nothing consumes the queue.
Config (all optional): `pollMs` 500, `batch` 20, `maxAttempts` 5, `backoffSeconds`
`[5, 30, 120, 600]`, `lockTtlSeconds` 300, `retentionDays` 7.
Steps: `events.emit:<name>`, `events.readQueueStatus`, `events.listDead` (`?limit`, max 500),
`events.retryDead:all` / `events.retryDead:one` (`params.id`), `events.purgeDone` (cron).
Not included: delivery across processes or a shared worker pool (the lock only prevents double
work), ordering, exactly-once, the `events@1` contract test (it asserts synchronous delivery and
a rejecting `emit`, which this module deliberately does not provide).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-events-queue` – module `events/queue`: provides `events@1`; requires `persistence@1`; provides the event trigger hook.

| Config | Type | Required | Default |
|---|---|---|---|
| `pollMs` | integer | no | `500` |
| `batch` | integer | no | `20` |
| `maxAttempts` | integer | no | `5` |
| `backoffSeconds` | array | no | `[5,30,120,600]` |
| `lockTtlSeconds` | integer | no | `300` |
| `retentionDays` | integer | no | `7` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `events.emit:<arg>` | Queue event "<arg>" for the subscribed handler pipelines; the worker delivers it after this run | – | – | – | – | 503 the event could not be persisted |
| `events.readQueueStatus` | Queue counters per state, the oldest pending event and the worker state of this process | – | `result` | – | { pending: number, running: number, dead: number, done24h: number, oldestPendingAt: number \| null, worker: object, … } | – |
| `events.listDead` | Dead-letter events, most recently failed first | – | `result` | ?limit: integer | { items: object[], … } | – |
| `events.retryDead:<arg>` | Requeue every dead-letter event | – | `result` | – | { retried: number, … } | – |
| `events.purgeDone` | Delete delivered events older than retentionDays | – | `result` | – | { removed: number, … } | – |

<!-- kestrel-docs:end -->
