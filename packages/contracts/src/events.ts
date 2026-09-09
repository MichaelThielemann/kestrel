import { defineContract } from "@michaelthielemann/kestrel/defineContract";


export type EventData = Record<string, unknown>;
export type EventHandler = (name: string, data: EventData) => Promise<void>;
export type Unsubscribe = () => void;

export interface Events {
  /**
   * Waits for every handler registered for `name`, in registration order, one at a time.
   * A throwing handler does not prevent the remaining handlers from running. If any handler
   * threw, `emit` rejects with an `AggregateError` (message `events: <n> handler(s) failed
   * for "<name>"`) whose `errors` holds the thrown values, in the order the handlers ran.
   * Resolves when none threw. Every handler receives the same shallowly frozen copy of `data`:
   * a handler cannot change what the next one sees, and assigning to it throws inside the handler.
   */
  emit(name: string, data: EventData): Promise<void>;
  on(name: string, handler: EventHandler): Unsubscribe;
}

export const EVENTS = defineContract<Events>()("events@1", ["emit", "on"]);
