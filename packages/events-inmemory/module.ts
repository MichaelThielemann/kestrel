import { z } from "zod";
import { EVENTS, type Events } from "@michaelthielemann/kestrel-contracts/events";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { createEventsInmemory } from "./impl.ts";

export default defineModule({
  name: "events/inmemory",
  provides: [EVENTS],
  requires: [],
  configSchema: z.object({}).strict(),

  async setup(): Promise<Events> {
    return createEventsInmemory();
  },
});
