import { defineStepSet } from "./stepSet.ts";

/** Every event delivery module registers this step; the bus module `events/inmemory` registers none. */
export const EVENT_DELIVERY_STEPS = defineStepSet({ id: "events.delivery", prefix: "events", steps: ["events.emit"] });
