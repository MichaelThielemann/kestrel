import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { EVENTS, type Events } from "@michaelthielemann/kestrel-contracts/events";
import { eventEnvelope } from "@michaelthielemann/kestrel-contracts/events.envelope";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { failure } from "@michaelthielemann/kestrel/errors";
import { ok } from "@michaelthielemann/kestrel/result";
import { startEventTriggers } from "./impl.ts";

export default defineModule({
  name: "events/direct",
  provides: [],
  requires: [EVENTS],
  configSchema: z.object({}).strict(),

  async setup(_config, deps): Promise<Events> {
    return deps.get(EVENTS);
  },

  triggers: { event: (bus, entries, run, logger) => startEventTriggers(bus, entries, run, logger) },

  steps: (bus) => ({
    emit: stepFactory((spec: string) => async (ctx: Context) => {
      const { name, envelope } = eventEnvelope(spec, ctx);
      try {
        await bus.emit(name, { ...envelope });
      } catch (error) {
        return ctx.fail(failure("INTERNAL", `events.emit: a handler failed for "${name}"`, { cause: error, details: { event: name } }));
      }
      return ok(ctx);
    }),
  }),

  describe: () => ({
    emit: (spec: string) => ({ summary: `Emit event "${spec}" to every subscribed handler pipeline and wait for them`, reads: [], writes: [], errors: { 500: "a subscribed handler failed" } }),
  }),
});
