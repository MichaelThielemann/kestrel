import { withEventIdentity } from "@michaelthielemann/kestrel-contracts/events.envelope";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { ContextInput } from "@michaelthielemann/kestrel/context";
import type { EventEntry } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import type { Runner } from "@michaelthielemann/kestrel/runner";

/** Subscribes the configured `{ event, pipeline }` entries to the bus and returns the unsubscribe. */
export function startEventTriggers(events: Events, entries: readonly EventEntry[], run: Runner, logger: Logger): () => void {
  const offs = entries.map((entry) =>
    events.on(entry.event, async (name, data) => {
      const payload = withEventIdentity(name, data);
      const input: ContextInput = { trigger: { kind: "event", name }, payload };
      if (typeof payload.runId === "string") input.parentRunId = payload.runId;
      const res = await run(entry.pipeline, input);
      if (res.status >= 400) logger.error(`event "${name}" pipeline "${entry.pipeline}" ended with ${res.status}`, { runId: res.runId, parentRunId: input.parentRunId ?? null, error: res.error, code: res.code, retryable: res.retryable });
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
