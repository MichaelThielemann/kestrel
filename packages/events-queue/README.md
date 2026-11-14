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
an event trigger. The worker starts with the event triggers in `start()`. `stop()` quiesces the
module before anything else: from that moment the main loop, every lane and `events.relay` claim no
further row, fan out nothing and scan for no lane, so no listener pipeline starts while the instance
drains its in-flight runs. A row already running finishes and is marked as usual. Rows the main loop
claimed in its batch but had not started go back to `pending`, unlocked, with their `attempts` and
`coalesceKey` as before the claim; a relay reports the rows it did not reach as `pending`. Every row
left pending is delivered after the next `start()`, or by another process on the same store, and
`events.emit` keeps writing rows during the shutdown. The worker itself stops in the module's
teardown, after the drain. Without any event trigger in the whole manifest, `setup()` installs an empty delivery table right
away (`start()` never gets the chance to), so `events.emit` drops the event instead of writing a row
nothing could ever fan out, and the worker never starts.
Config (all optional): `pollMs` 500, `batch` 20, `maxAttempts` 5, `backoffSeconds`
`[5, 30, 120, 600]`, `lockTtlSeconds` 300, `retentionDays` 7, `relayMs` 5000, `relayPipelines`
`"all"`, `lanes` `{}`, `delayMs` `{}`.
Steps: `events.emit:<name>`, `events.readQueueStatus`, `events.listDead` (`?limit`, max 500;
each item names its `pipeline` and `runId`), `events.retryDead:all` / `events.retryDead:one`
(`params.id`, retries one pipeline's copy), `events.purgeDone` (cron), `events.relay`.
Not included: delivery across processes or a shared worker pool (the lock only prevents double
work), ordering between pipelines of one event, exactly-once, the `events@1` contract test (this
module does not provide `events@1`).

Every row carries the `runId` of the run whose `events.emit` wrote it (`null` for a row raised
through `events@1` outside a pipeline). A row belonging to a run is written with `availableAt =
createdAt + relayMs` instead of being immediately due (except for a pipeline with a delay in
`delayMs`, which the relay never claims; see below), so `events.relay` — placed after a
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
pipeline that is not in the booted manifest, or one that no event trigger runs and so never gets a
row, fails at `attach()`, once every pipeline is resolved, with an error naming the module, the
pipeline(s) and which of the two it is.

`events.readDeliveryStatus` answers `{ dead, scope: "store", since: null, lastDeadAt }`: the
dead-letter rows across every process, the same count `events.readQueueStatus.dead` already
carries. `since` stays `null` because the count is a store total, not a per-process one; a retry
through `events.retryDead` lowers it. The number never reaches `kestrel.health()` or a readiness
probe — a dead letter does not take the instance out of rotation.

An event whose data carries a string `coalesceKey` is coalesced: for each subscribed pipeline,
`enqueue` writes at most one row per `"<pipeline>:<coalesceKey>"` while an earlier row of that key
has not started — a later `enqueue` with the same key hits a `CONFLICT` on the unique
`coalesceKey` column and writes nothing, instead of failing the run. A claim, whether by the
worker, a lane's own loop or the relay, clears the row's `coalesceKey` the moment it starts
running, so a fresh event with the same key can be enqueued again once that row is merely running,
before it has finished. If the key's holder is found to be some other, non-pending state (for
example a row a pre-6.0 process claimed without knowing the column), `enqueue` clears it and
writes the row instead of silently doing nothing. An event with no `coalesceKey` is never
coalesced, and a `CONFLICT` on any other column still fails `emit` as before. `coalesceKey` is a
plain string on the event's data; this module attaches no meaning to it beyond the key.
**Coalescing keeps the first event's payload**: a later event that joins a pending row is dropped
with its data, so a listener pipeline must read the current state rather than rely on the payload
of the event it was started with. Each row also keeps its key in `originKey`, which is never
cleared, so rows of the same key stay related after a claim. When a row fails, only the newest
`pending` row of its key is kept: a failed row is superseded when a `pending` row holds the key or
a newer `pending` row shares its `originKey`, and otherwise it supersedes every older `pending`
row of its `originKey` (one waiting for its retry) before it is scheduled for its own. A superseded
row is marked `done` with its error kept, instead of being retried or moved to dead-letter, because
the row that is kept does the same work, so a job requested again and again during an outage keeps
at most one retrying row and dead-letters nothing. Each supersede is logged, and a relay reports a
superseded row as `error`, never as `dead`. A failed row with no other pending row of its key, or
only a running one, is retried as usual. Recording an outcome never writes the key back to the
failed row.

`delayMs` (default `{}`) holds a pipeline's rows back: `{ "<pipeline>": <milliseconds> }`, whole
non-negative numbers checked in the config schema. A row of a pipeline with a delay is written, and
fanned out from an unfanned row, with `availableAt` set that many milliseconds after the moment it
is written. Together with `coalesceKey` this is a fixed window, not a debounce: the first event
opens the window, every event with the same key that arrives while the row is still pending joins
that row without moving its `availableAt`, and the row runs once when the window ends. An event
after the claim opens the next window. A delayed pipeline is never relayed — its rows get no head
start, the relay never claims them, and `_events.pipelines` names them with `status: "queued"` —
whatever `relayPipelines` says. A delay of `0`, like a pipeline left out, changes nothing. A
delayed pipeline may also be in a lane; its lane claims the row once the window ends. `attach()`
rejects a `delayMs` entry naming a pipeline the booted manifest does not know or one no event
trigger runs, and a pipeline with a delay above `0` that an array `relayPipelines` also names.

`lanes` (default `{}`) gives named pipelines their own worker loop: `{ "<lane>": ["<pipeline>",
…] }`. A lane name matches `^[a-z][a-z0-9-]*$` (checked in the config schema; `main` is reserved
there for the pipelines no lane names), and `attach()` rejects a pipeline the booted manifest does
not know, one no event trigger runs, one in two lanes, and one in both a lane and `relayPipelines`. Every pipeline not listed runs in the implicit `main` lane, together
with the worker's fan-out of unfanned rows and a sweep that reclaims every lane's expired locks;
each lane's own claim also reclaims that lane's expired locks first, so a crashed process's row is
retried by its own lane without waiting for the main loop. Each named lane runs its own
single-flight loop that claims and runs one due row of its own pipelines at a time, on the same
`pollMs`, and retries at once rather than waiting `pollMs` when it loses a claim race to another
process; the relay never claims a lane row, whatever `relayPipelines` says. **A due row of one lane
never waits for a row of another lane or of the main loop** — each loop claims independently, so
however many rows are blocked in one lane, every other lane and the main loop keep claiming and
running theirs. The cost: every running loop shares the process's CPU. Each lane, like the main
loop, still runs one row at a time — that is the guarantee: one lane's rows are never delayed by
another's. Running several lanes overlaps their I/O and CPU-bound work (a page render's I/O,
`sharp`'s thread pool), so the combined throughput across lanes is higher with more lanes busy, not
lower. `events.readQueueStatus` reports every lane this process currently knows of — configured, or
found holding a row — with `pending`, `running` and `oldestPendingAt` under `lanes`; the top-level
counters keep counting every row regardless of lane. Moving a pipeline out of a lane, or dropping
the lane from the config, changes only where new rows land: the main loop re-scans for a lane it
does not know of holding a `pending` or `running` row, at most every 30 seconds in every process,
and at once, in the process that served it, right after `events.retryDead` (another process still
picks the lane up within its own 30-second window); either way it starts that lane's loop, so no
row is left without a loop to serve it, and a lane found this way keeps its loop across that
process's own later stop/start pairs. Every process sharing one queue should run the same `lanes`; a
process missing a lane runs its pipelines in its own main loop instead, and its relay (with
`"all"`) gives
them a head start the other processes' lanes never would.

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
| `lanes` | record | no | `{}` |
| `delayMs` | record | no | `{}` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `events.emit:<arg>` | Queue event "<arg>" for the subscribed handler pipelines; the worker delivers it after this run | – | – | – | – | 503 the event could not be persisted | portable | yes |
| `events.readQueueStatus` | Queue counters per state, the oldest pending event, the worker state of this process, and pending/running/oldestPendingAt per configured lane | – | `result` | – | { pending: number, running: number, dead: number, done24h: number, oldestPendingAt: number \| null, worker: object, lanes: object, … } | – | beside | yes |
| `events.readDeliveryStatus` | Dead-letter rows of the queue across every process: deliveries that used up maxAttempts and wait for events.retryDead | – | `result` | – | { dead: integer, scope: "store" \| "process", since: number \| null, lastDeadAt: number \| null, … } | 503 the queue could not be read | portable | yes |
| `events.listDead` | Dead-letter events, most recently failed first | – | `result` | ?limit: integer | { items: object[], … } | – | beside | yes |
| `events.retryDead:<arg>` | Requeue every dead-letter event | – | `result` | – | { retried: number, … } | – | beside | yes |
| `events.purgeDone` | Delete delivered events older than retentionDays | – | `result` | – | { removed: number, … } | – | beside | yes |
| `events.relay` | Deliver the events this run queued, before the response; whatever is left over stays for the worker (adds `_events` to the result) | – | `result._events` | – | { _events: object, … } | – | portable | no |

<!-- kestrel-docs:end -->
