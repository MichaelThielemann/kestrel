# events/direct
Inline delivery for event-trigger pipelines: subscribes the configured `{ event, pipeline }` entries
to the `events@1` bus and runs each matching pipeline within the emitting request. Today's
implementation runs the pipelines subscribed to one event one at a time, in registration order,
and isolates them from each other — a throwing pipeline is logged like a failed one and does not
stop the rest — but this is not a guarantee: **the pipelines subscribed to one event are
independent of each other; work that must happen in sequence belongs in one pipeline.**
`events.emit:<name>` builds the shared envelope
(`{ eventId, event, at, runId, identity, params, id }`, plus `ids`/`result` where they apply) and
waits for every subscribed handler. A failing handler is not swallowed: the step answers 500
`INTERNAL` with the aggregated failure as `cause`, so it shows up in the run's log line and in
`describe().errors` instead of being logged and ignored.

Requires `events@1` (`@michaelthielemann/kestrel-events-inmemory` or another bus module) and
provides the core's `triggers.event` hook, so exactly one of `events/direct` or `events/queue` must
be configured whenever a pipeline has an event trigger. Not included: delivery across processes or
restarts, retries, or a dead-letter list — for those, use `events/queue`.

`events.relay`, placed after a pipeline's last `events.emit:`, reports what that run's own emits
already delivered — the subscribed pipelines have run by the time it executes, inline, during
`events.emit`. It adds `_events: { status, pipelines: [{ event, pipeline, status, attempts, dead,
error }] }` to the result: `status` is `"done"` when a subscribed pipeline answered under 400,
`"error"` when it answered ≥ 400 or threw (`attempts` is always `1`, `dead` is always `true`,
because nothing here retries). A run whose emits had no subscriber, or whose relay never ran,
reports `{ status: "done", pipelines: [] }`. Recorded outcomes older than 60 seconds are dropped on
the next emit with one `warn` naming the count, so the map cannot leak past a stuck relay.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-events-direct` – module `events/direct`: provides no contract; requires `events@1`; provides the event trigger hook.

Config: `{}` – nothing to set.

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `events.emit:<arg>` | Emit event "<arg>" to every subscribed handler pipeline and wait for them | – | – | – | – | 500 a subscribed handler failed | portable | no |
| `events.relay` | Report how the events this run raised were delivered (adds `_events` to the result) | – | `result._events` | – | { _events: object, … } | – | portable | no |

Used by 14 of 85 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
