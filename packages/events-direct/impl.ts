import { withEventIdentity } from "@michaelthielemann/kestrel-contracts/events.envelope";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { ContextInput } from "@michaelthielemann/kestrel/context";
import type { EventEntry } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import type { Runner } from "@michaelthielemann/kestrel/runner";

/**
 * Subscribes the configured `{ event, pipeline }` entries to the bus and returns the unsubscribe.
 * One bus subscription per distinct event name: `withEventIdentity` runs once per emit, before any
 * subscribed pipeline of that event sees the data, so all of them get the same `eventId`/`event`/`at`
 * rather than each minting its own when the emitter did not supply one.
 */
export function startEventTriggers(events: Events, entries: readonly EventEntry[], run: Runner, logger: Logger): () => void {
  const pipelinesByEvent = new Map<string, string[]>();
  for (const entry of entries) {
    const pipelines = pipelinesByEvent.get(entry.event) ?? [];
    pipelines.push(entry.pipeline);
    pipelinesByEvent.set(entry.event, pipelines);
  }
  const offs = [...pipelinesByEvent].map(([event, pipelines]) =>
    events.on(event, async (name, data) => {
      const payload = withEventIdentity(name, data);
      const input: ContextInput = { trigger: { kind: "event", name }, payload };
      if (typeof payload.runId === "string") input.parentRunId = payload.runId;
      const thrown: unknown[] = [];
      for (const pipeline of pipelines) {
        try {
          const res = await run(pipeline, input);
          if (res.status >= 400) logger.error(`event "${name}" pipeline "${pipeline}" ended with ${res.status}`, { runId: res.runId, parentRunId: input.parentRunId ?? null, error: res.error, code: res.code, retryable: res.retryable });
        } catch (error) {
          logger.error(`event "${name}" pipeline "${pipeline}" threw`, { error });
          thrown.push(error);
        }
      }
      if (thrown.length > 0) throw thrown.length === 1 ? thrown[0] : new AggregateError(thrown, `events/direct: ${thrown.length} pipeline(s) threw for "${name}"`);
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
