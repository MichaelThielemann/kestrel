import type { EventHandler, Events } from "@michaelthielemann/kestrel-contracts/events";

export function createEventsInmemory(): Events {
  const handlers = new Map<string, Set<EventHandler>>();
  return {
    async emit(name, data) {
      const set = handlers.get(name);
      if (!set) return;
      const errors: unknown[] = [];
      const frozen = Object.freeze({ ...data });
      for (const handler of [...set]) {
        try {
          await handler(name, frozen);
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
