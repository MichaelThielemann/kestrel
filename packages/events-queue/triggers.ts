import type { ContextInput } from "@michaelthielemann/kestrel/context";
import type { EventEntry } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import type { Runner } from "@michaelthielemann/kestrel/runner";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";

/** A handler pipeline that ends with a failure status throws, so the queue counts the attempt and retries; the run itself is logged by the runner. */
export function startEventTriggers(events: Events, entries: readonly EventEntry[], run: Runner, logger: Logger): () => void {
  const offs = entries.map((entry) =>
    events.on(entry.event, async (name, data) => {
      const input: ContextInput = { trigger: { kind: "event", name }, payload: data };
      if (typeof data.runId === "string") input.parentRunId = data.runId;
      const res = await run(entry.pipeline, input);
      if (res.status >= 400) {
        logger.error(`event "${name}" pipeline "${entry.pipeline}" ended with ${res.status}`, { runId: res.runId, parentRunId: input.parentRunId ?? null, error: res.error, code: res.code, retryable: res.retryable });
        throw new Error(`pipeline "${entry.pipeline}" ended with ${res.status}: ${res.error ?? res.code ?? ""}`);
      }
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
