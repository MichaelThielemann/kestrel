# events/inmemory
`events@1` inside one process: handlers run in registration order, `emit` resolves after the
last one; a throwing handler does not stop the rest, but `emit` then rejects with an
`AggregateError` collecting all of them. This module is the bus only — it registers no step and no
event trigger hook. Delivering event-trigger pipelines is the job of exactly one delivery module,
`@michaelthielemann/kestrel-events-direct` (inline) or `@michaelthielemann/kestrel-events-queue`
(outbox); configure one of them next to this module whenever a pipeline has an event trigger.
Not included: delivery across processes or restarts (use `events/queue`, or a broker-backed bus
module).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-events-inmemory` – module `events/inmemory`: provides `events@1`.

Config: `{}` – nothing to set.

<!-- kestrel-docs:end -->
