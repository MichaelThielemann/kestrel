import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { ok } from "@michaelthielemann/kestrel/result";
import { eventDeliveryStepTests, type EventDeliveryFixture } from "../events.steps.contract.test.ts";
import { eventEnvelope, withEventIdentity } from "../events.envelope.ts";
import { mergeRelayReport, RELAY_SCHEMA } from "../events.steps.ts";
import type { EventData } from "../events.ts";

function fakeDeliveryFixture(): EventDeliveryFixture {
  const delivered: EventData[] = [];
  return {
    steps: {
      emit: stepFactory((spec: string) => async (ctx: Context) => {
        const { envelope } = eventEnvelope(spec, ctx);
        delivered.push({ ...envelope });
        return ok({ ...ctx, result: envelope });
      }),
      relay: async (ctx: Context) => ok({ ...ctx, result: mergeRelayReport(ctx.result, { status: "done", pipelines: [] }, "fake/delivery") }),
    },
    describe: {
      emit: (spec: string) => ({ summary: `Emit event "${spec}" to every subscribed handler pipeline`, reads: [], writes: [], errors: { 500: "a subscribed handler failed" } }),
      relay: { summary: "Report how the events this run raised were delivered (adds `_events` to the result)", reads: [], writes: ["result._events"], extendsOutput: RELAY_SCHEMA },
    },
    async raise(event, data) {
      const identified = withEventIdentity(event, data);
      delivered.push(identified, { ...identified });
    },
    async delivered() {
      return delivered.map((entry) => boundaryCast<EventData>(JSON.parse(JSON.stringify(entry)), "json"));
    },
  };
}

eventDeliveryStepTests(async () => fakeDeliveryFixture());
