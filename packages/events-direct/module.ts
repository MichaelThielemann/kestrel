import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { EVENTS, type Events } from "@michaelthielemann/kestrel-contracts/events";
import { eventEnvelope } from "@michaelthielemann/kestrel-contracts/events.envelope";
import { mergeRelayReport, relaySummary, RELAY_SCHEMA } from "@michaelthielemann/kestrel-contracts/events.steps";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { failure } from "@michaelthielemann/kestrel/errors";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { createRelayReports, startEventTriggers, type RelayReports } from "./impl.ts";

const SWEEP_AFTER_MS = 60_000;

interface DirectInstance {
  bus: Events;
  reports: RelayReports;
  logger: Logger;
}

export default defineModule({
  name: "events/direct",
  provides: [],
  requires: [EVENTS],
  configSchema: z.object({}).strict(),

  async setup(_config, deps): Promise<DirectInstance> {
    return { bus: deps.get(EVENTS), reports: createRelayReports(), logger: deps.logger };
  },

  triggers: { event: (instance, entries, run, logger) => startEventTriggers(instance.bus, entries, run, logger, instance.reports) },

  steps: (instance) => ({
    emit: stepFactory((spec: string) => async (ctx: Context) => {
      const { name, envelope } = eventEnvelope(spec, ctx);
      instance.reports.sweep(SWEEP_AFTER_MS, (count) => logWarn(instance.logger, `events/direct: dropped ${count} unreported run(s)`));
      try {
        await instance.bus.emit(name, { ...envelope });
      } catch (error) {
        return ctx.fail(failure("INTERNAL", `events.emit: a handler failed for "${name}"`, { cause: error, details: { event: name } }));
      }
      return ok(ctx);
    }),
    relay: async (ctx: Context) => {
      const entries = instance.reports.take(ctx.runId) ?? [];
      const report = { status: relaySummary(entries), pipelines: entries };
      return ok({ ...ctx, result: mergeRelayReport(ctx.result, report, (message) => logWarn(instance.logger, message), "events/direct") });
    },
  }),

  describe: () => ({
    emit: (spec: string) => ({ summary: `Emit event "${spec}" to every subscribed handler pipeline and wait for them`, reads: [], writes: [], errors: { 500: "a subscribed handler failed" } }),
    relay: {
      summary: "Report how the events this run raised were delivered (adds `_events` to the result)",
      reads: [],
      writes: ["result._events"],
      extendsOutput: RELAY_SCHEMA,
    },
  }),
});
