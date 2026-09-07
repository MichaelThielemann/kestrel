import { randomUUID } from "node:crypto";
import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { EVENTS, type Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { createEventsInmemory, startEventTriggers } from "./impl.ts";

export default defineModule({
  name: "events/inmemory",
  provides: [EVENTS],
  requires: [],
  configSchema: z.object({}).strict(),

  async setup(_config, deps): Promise<Events & { logger: Logger }> {
    return { ...createEventsInmemory(), logger: deps.logger };
  },

  triggers: { event: (events, entries, run, logger) => startEventTriggers(events, entries, run, logger) },

  steps: (events) => ({
    // Arg syntax mirrors other steps ("name:arg"): "events.emit:page.created?with=result"
    // parses the same way authz.require:x parses its own colon-delimited argument.
    emit: stepFactory((spec: string) => async (ctx: Context) => {
      const questionMark = spec.indexOf("?");
      const name = questionMark === -1 ? spec : spec.slice(0, questionMark);
      const withResult = questionMark !== -1 && new URLSearchParams(spec.slice(questionMark + 1)).get("with") === "result";
      const result = ctx.result as { id?: unknown; document?: { id?: unknown }; ids?: unknown } | undefined;
      const id = typeof result?.id === "string" ? result.id : typeof result?.document?.id === "string" ? result.document.id : typeof ctx.params.id === "string" ? ctx.params.id : null;
      const envelope: Record<string, unknown> = { eventId: randomUUID(), event: name, at: Date.now(), runId: ctx.runId, identity: ctx.identity ?? null, params: ctx.params, id };
      if (Array.isArray(result?.ids) && result.ids.every((v): v is string => typeof v === "string")) envelope.ids = result.ids;
      if (withResult) envelope.result = ctx.result ?? null;
      try {
        await events.emit(name, envelope);
      } catch (error) {
        events.logger.error("events: handler failed", { event: name, error });
      }
      return ok(ctx);
    }),
  }),

  describe: () => ({
    emit: (spec: string) => ({ summary: `Emit event "${spec}" to every subscribed handler pipeline`, reads: [], writes: [] }),
  }),
});
