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
without any event trigger in the whole manifest, `setup()` installs an empty delivery table right
away (`start()` never gets the chance to), so `events.emit` drops the event instead of writing a row
nothing could ever fan out, and the worker never starts.
Config (all optional): `pollMs` 500, `batch` 20, `maxAttempts` 5, `backoffSeconds`
`[5, 30, 120, 600]`, `lockTtlSeconds` 300, `retentionDays` 7, `relayMs` 5000, `relayPipelines`
`"all"`.
Steps: `events.emit:<name>`, `events.readQueueStatus`, `events.listDead` (`?limit`, max 500;
each item names its `pipeline` and `runId`), `events.retryDead:all` / `events.retryDead:one`
(`params.id`, retries one pipeline's copy), `events.purgeDone` (cron), `events.relay`.
Not included: delivery across processes or a shared worker pool (the lock only prevents double
work), ordering between pipelines of one event, exactly-once, the `events@1` contract test (this
module does not provide `events@1`).

Every row carries the `runId` of the run whose `events.emit` wrote it (`null` for a row raised
through `events@1` outside a pipeline). A row belonging to a run is written with `availableAt =
createdAt + relayMs` instead of being immediately due, so `events.relay` — placed after a
pipeline's last `events.emit:` — gets a head start: it claims its own run's rows by id regardless
of `availableAt`, runs each one through the same attempt/backoff/dead-letter machinery as the
worker, and reports the outcome as `_events: { status, pipelines: [{ event, pipeline, status,
attempts, dead, error }] }` on the result. A row the relay does not reach within `relayMs` — the
budget is checked before every claim, including the first, and is never enforced mid-pipeline —
stays `pending` and is reported the same way; the worker delivers it once its `availableAt` comes
due, exactly like any other leftover. `relayMs: 0` disables the relay: every row is immediately
the worker's, and the relay claims nothing. A run that enqueued nothing costs the relay zero
queries — the ids it would claim are tracked in memory, keyed by `runId`, and discarded once
relayed or once `lockTtlSeconds` pass with no relay.

`relayPipelines` narrows which subscribed pipelines the relay may claim: an array of pipeline
names, or `"all"` (the default), which keeps the behaviour above for every subscribed pipeline. A
row of a pipeline left out of the list is written with `availableAt = createdAt` — no head start —
and the relay never claims it by id, so it is the worker's from the moment the request that raised
it returns; `_events.pipelines` still names it, with `status: "queued"`. This is how a heavy
subscriber (rendering image variants on upload, writing a login audit) stays off the request while
a subscriber that must show up in the response (publishing a page) keeps its head start. Naming a
pipeline that is not in the booted manifest fails at `attach()`, once every pipeline is resolved,
with an error naming the module and the unknown pipeline(s).

`events.readDeliveryStatus` answers `{ dead, scope: "store", since: null, lastDeadAt }`: the
dead-letter rows across every process, the same count `events.readQueueStatus.dead` already
carries. `since` stays `null` because the count is a store total, not a per-process one; a retry
through `events.retryDead` lowers it. The number never reaches `kestrel.health()` or a readiness
probe — a dead letter does not take the instance out of rotation.

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
| `relayMs` | integer | no | `5000` |
| `relayPipelines` | union | no | `"all"` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `events.emit:<arg>` | Queue event "<arg>" for the subscribed handler pipelines; the worker delivers it after this run | – | – | – | – | 503 the event could not be persisted | portable | yes |
| `events.readQueueStatus` | Queue counters per state, the oldest pending event and the worker state of this process | – | `result` | – | { pending: number, running: number, dead: number, done24h: number, oldestPendingAt: number \| null, worker: object, … } | – | beside | yes |
| `events.readDeliveryStatus` | Dead-letter rows of the queue across every process: deliveries that used up maxAttempts and wait for events.retryDead | – | `result` | – | { dead: integer, scope: "store" \| "process", since: number \| null, lastDeadAt: number \| null, … } | 503 the queue could not be read | portable | no |
| `events.listDead` | Dead-letter events, most recently failed first | – | `result` | ?limit: integer | { items: object[], … } | – | beside | yes |
| `events.retryDead:<arg>` | Requeue every dead-letter event | – | `result` | – | { retried: number, … } | – | beside | yes |
| `events.purgeDone` | Delete delivered events older than retentionDays | – | `result` | – | { removed: number, … } | – | beside | yes |
| `events.relay` | Deliver the events this run queued, before the response; whatever is left over stays for the worker (adds `_events` to the result) | – | `result._events` | – | { _events: object, … } | – | portable | no |

<!-- kestrel-docs:end -->
