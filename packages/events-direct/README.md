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

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-events-direct` – module `events/direct`: provides no contract; requires `events@1`; provides the event trigger hook.

Config: `{}` – nothing to set.

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable |
|---|---|---|---|---|---|---|---|
| `events.emit:<arg>` | Emit event "<arg>" to every subscribed handler pipeline and wait for them | – | – | – | – | 500 a subscribed handler failed | portable |

Used by 14 of 83 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
