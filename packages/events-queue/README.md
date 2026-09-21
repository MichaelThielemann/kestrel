# events/queue
Outbox delivery for event-trigger pipelines: `events@1` stays the bus
(`@michaelthielemann/kestrel-events-inmemory`), and this module delivers to pipelines instead of
the bus delivering to programmatic handlers. `emit` writes one row per pipeline subscribed to the
event to `events_queue` (via `persistence@1`) and returns without touching the bus; an event
nobody subscribes to writes nothing. An in-process worker claims due rows every `pollMs` and runs
each row's own pipeline with a frozen copy of the payload, then marks the row `done`. A failing
run counts an attempt for that row alone and requeues it after `backoffSeconds[attempt - 1]` (the
last entry repeats); at `maxAttempts` the row is `dead` with its own error. **There is no ordering
between the pipelines subscribed to one event** — each is its own row, claimed and retried
independently, so a failing pipeline never re-runs the others. The pipelines subscribed to one
event are independent of each other; work that must happen in sequence belongs in one pipeline. A
row stuck in `running` longer
than `lockTtlSeconds` (a crashed process) is picked up again. Delivery is therefore at least once
per pipeline; a listener pipeline must be idempotent (`payload.eventId` is the dedup key). The
triggering pipeline does not wait for delivery; `emit` rejects only when the row cannot be
written, and the `events.emit` step then fails the run with the persistence error (503
`TRANSIENT`) instead of dropping the event.

This module also requires `events@1`: at `setup()` it subscribes on the bus to every event name a
configured pipeline trigger names, so an event a module raises through `events@1` directly (for
example `migrations.applied`) is queued too, and a failed insert rejects that emit the same way.
Because the delivery table is only installed once `start()` runs, such an event — and any event
emitted while the module list is still being set up — is stored with no pipeline attached yet;
the worker fans it out to every currently subscribed pipeline at the start of its first tick. The
same mechanism delivers rows left over from a version before this one: they carry no pipeline
either, so the first tick after an upgrade fans each of them out to whatever currently subscribes,
which may include a pipeline that was not subscribed when the event was originally raised.

Requires exactly one delivery module per instance — this one or
`@michaelthielemann/kestrel-events-direct` (inline), never both, never neither once a pipeline has
an event trigger. The worker starts with the event triggers in `start()` and stops on `stop()`;
without any event trigger nothing consumes the queue.
Config (all optional): `pollMs` 500, `batch` 20, `maxAttempts` 5, `backoffSeconds`
`[5, 30, 120, 600]`, `lockTtlSeconds` 300, `retentionDays` 7.
Steps: `events.emit:<name>`, `events.readQueueStatus`, `events.listDead` (`?limit`, max 500;
each item names its `pipeline`), `events.retryDead:all` / `events.retryDead:one` (`params.id`,
retries one pipeline's copy), `events.purgeDone` (cron).
Not included: delivery across processes or a shared worker pool (the lock only prevents double
work), ordering between pipelines of one event, exactly-once, the `events@1` contract test (this
module does not provide `events@1`).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-events-queue` – module `events/queue`: provides no contract; requires `persistence@1`, `events@1`; provides the event trigger hook.

| Config | Type | Required | Default |
|---|---|---|---|
| `pollMs` | integer | no | `500` |
| `batch` | integer | no | `20` |
| `maxAttempts` | integer | no | `5` |
| `backoffSeconds` | array | no | `[5,30,120,600]` |
| `lockTtlSeconds` | integer | no | `300` |
| `retentionDays` | integer | no | `7` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable |
|---|---|---|---|---|---|---|---|
| `events.emit:<arg>` | Queue event "<arg>" for the subscribed handler pipelines; the worker delivers it after this run | – | – | – | – | 503 the event could not be persisted | portable |
| `events.readQueueStatus` | Queue counters per state, the oldest pending event and the worker state of this process | – | `result` | – | { pending: number, running: number, dead: number, done24h: number, oldestPendingAt: number \| null, worker: object, … } | – | beside |
| `events.listDead` | Dead-letter events, most recently failed first | – | `result` | ?limit: integer | { items: object[], … } | – | beside |
| `events.retryDead:<arg>` | Requeue every dead-letter event | – | `result` | – | { retried: number, … } | – | beside |
| `events.purgeDone` | Delete delivered events older than retentionDays | – | `result` | – | { removed: number, … } | – | beside |

<!-- kestrel-docs:end -->
