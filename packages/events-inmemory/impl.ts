import type { ContextInput } from "@michaelthielemann/kestrel/context";
import type { EventEntry } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import type { Runner } from "@michaelthielemann/kestrel/runner";
import type { EventHandler, Events } from "@michaelthielemann/kestrel-contracts/events";

export function createEventsInmemory(): Events {
  const handlers = new Map<string, Set<EventHandler>>();
  return {
    async emit(name, data) {
      const set = handlers.get(name);
      if (!set) return;
      const errors: unknown[] = [];
      for (const handler of [...set]) {
        try {
          await handler(name, data);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `events: ${errors.length} handler(s) failed for "${name}"`);
      }
    },
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  };
}

export function startEventTriggers(events: Events, entries: readonly EventEntry[], run: Runner, logger: Logger): () => void {
  const offs = entries.map((entry) =>
    events.on(entry.event, async (name, data) => {
      const input: ContextInput = { trigger: { kind: "event", name }, payload: data };
      if (typeof data.runId === "string") input.parentRunId = data.runId;
      const res = await run(entry.pipeline, input);
      if (res.status >= 400) logger.error(`event "${name}" pipeline "${entry.pipeline}" ended with ${res.status}`, { runId: res.runId, parentRunId: input.parentRunId ?? null, error: res.error, code: res.code, retryable: res.retryable });
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
