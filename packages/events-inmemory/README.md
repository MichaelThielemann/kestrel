# events/inmemory
`events@1` inside one process: handlers run in registration order, `emit` resolves after the
last one; a throwing handler does not stop the rest, but `emit` then rejects with an
`AggregateError` collecting all of them. Step `events.emit:<name>` throws
`{ eventId, event, at, runId, identity, params, id }` of the running pipeline — `eventId` is a fresh
UUID per emit (a dedup key for consumers), `runId` the id of the emitting run; a listener failure is
logged and does not fail the step. Required for event triggers in `kestrel.config.ts`.
Provides the core's `triggers.event` hook: it subscribes the configured `{ event, pipeline }` entries
to its own bus and returns the unsubscribe the core calls on `stop()`. The envelope's `runId` is
passed to the handler pipeline as `parentRunId`, so its step log lines point back at the run that
emitted the event.
Not included: delivery across processes or restarts (use a broker-backed events module).
