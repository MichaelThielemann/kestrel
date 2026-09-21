import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context, Step, StepFactory, StepResult } from "@michaelthielemann/kestrel/context";
import type { StepDescription } from "@michaelthielemann/kestrel/defineModule";
import type { CoreCode, KestrelError } from "@michaelthielemann/kestrel/errors";
import { stepPrefix } from "@michaelthielemann/kestrel/defineModule";
import { EVENT_DELIVERY_STEPS } from "./events.steps.ts";
import type { EventData } from "./events.ts";

export interface EventDeliveryFixture {
  steps: Record<string, unknown>;
  describe: Record<string, unknown>;
  /** Puts data on the bus for `event`, as a module raising through `events@1` would. */
  raise(event: string, data: EventData): Promise<void>;
  /** What this module handed to pipelines, in order, JSON round-tripped. */
  delivered(): Promise<readonly EventData[]>;
}

const PREFIX = stepPrefix(EVENT_DELIVERY_STEPS.prefix);
const EMIT_KEY = EVENT_DELIVERY_STEPS.steps[0]!.slice(PREFIX.length + 1);

function fakeCtx(overrides: Partial<Context> = {}): Context {
  return {
    runId: "run-1",
    trigger: { kind: "http", name: "t" },
    payload: {},
    body: {},
    query: {},
    params: {},
    headers: {},
    files: [],
    fail(codeOrError: CoreCode | KestrelError, message?: string): never {
      throw new Error(`${typeof codeOrError === "string" ? codeOrError : codeOrError.code} ${message ?? ""}`);
    },
    done: () => {
      throw new Error("done called");
    },
    ...overrides,
  };
}

function emitStepOf(fixture: EventDeliveryFixture): (spec: string) => Step {
  return boundaryCast<StepFactory>(fixture.steps[EMIT_KEY], "host");
}

function describeEmitOf(fixture: EventDeliveryFixture): (spec: string) => StepDescription {
  return boundaryCast<(spec: string) => StepDescription>(fixture.describe[EMIT_KEY], "host");
}

async function runEmit(fixture: EventDeliveryFixture, spec: string, ctx: Context): Promise<StepResult> {
  const emit = emitStepOf(fixture)(spec);
  return emit(ctx);
}

function envelopeOf(result: StepResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`emit failed: ${result.error.code} ${result.error.message}`);
  return boundaryCast<Record<string, unknown>>(result.value.result, "json");
}

/** Shared behaviour of the step every event delivery module registers: `events.emit`. */
export function eventDeliveryStepTests(make: () => Promise<EventDeliveryFixture>): void {
  describe("events.delivery steps", () => {
    it("registers every step of EVENT_DELIVERY_STEPS with a describe() entry", async () => {
      const fixture = await make();
      for (const full of EVENT_DELIVERY_STEPS.steps) {
        const key = full.slice(PREFIX.length + 1);
        expect(fixture.steps[key], `steps.${key}`).toBeTypeOf("function");
        expect(fixture.describe[key], `describe.${key}`).toBeDefined();
      }
    });

    it("declares errors on events.emit and a plain summary", async () => {
      const fixture = await make();
      const description = describeEmitOf(fixture)("x");
      expect(description.summary).toContain("x");
      expect(description.errors).toBeDefined();
    });

    it("a plain emit's envelope has exactly {eventId, event, at, runId, identity, params, id}", async () => {
      const fixture = await make();
      const before = Date.now();
      const res = await runEmit(fixture, "page.created", fakeCtx());
      const after = Date.now();
      const envelope = envelopeOf(res);
      expect(Object.keys(envelope).sort()).toEqual(["at", "event", "eventId", "id", "identity", "params", "runId"]);
      expect(envelope.at).toBeGreaterThanOrEqual(before);
      expect(envelope.at).toBeLessThanOrEqual(after);
    });

    it("eventId is a distinct UUID per emit", async () => {
      const fixture = await make();
      const a = envelopeOf(await runEmit(fixture, "x", fakeCtx()));
      const b = envelopeOf(await runEmit(fixture, "x", fakeCtx()));
      expect(a.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(a.eventId).not.toBe(b.eventId);
    });

    it("event, runId, identity and params equal the emitting context's values", async () => {
      const fixture = await make();
      const identity = { id: "u1", claims: {} };
      const res = await runEmit(fixture, "x.happened", fakeCtx({ runId: "run-a", identity, params: { slug: "s" } }));
      const envelope = envelopeOf(res);
      expect(envelope.event).toBe("x.happened");
      expect(envelope.runId).toBe("run-a");
      expect(envelope.identity).toEqual(identity);
      expect(envelope.params).toEqual({ slug: "s" });
    });

    it("derives id from result.id, result.document.id, params.id or null, in that order", async () => {
      const fixture = await make();
      expect(envelopeOf(await runEmit(fixture, "x", fakeCtx({ params: { id: "from-params" }, result: { id: "from-result" } }))).id).toBe("from-result");
      expect(envelopeOf(await runEmit(fixture, "x", fakeCtx({ result: { document: { id: "from-document" } } }))).id).toBe("from-document");
      expect(envelopeOf(await runEmit(fixture, "x", fakeCtx({ params: { id: "from-params" } }))).id).toBe("from-params");
      expect(envelopeOf(await runEmit(fixture, "x", fakeCtx())).id).toBeNull();
    });

    it("ids appears only for an all-string result.ids array", async () => {
      const fixture = await make();
      expect(envelopeOf(await runEmit(fixture, "x", fakeCtx({ result: { ids: ["a", "b"] } }))).ids).toEqual(["a", "b"]);
      expect(envelopeOf(await runEmit(fixture, "x", fakeCtx({ result: { ids: ["a", 1] } }))).ids).toBeUndefined();
    });

    it("result is absent without ?with=result, present with it, null when ctx.result is undefined", async () => {
      const fixture = await make();
      expect(envelopeOf(await runEmit(fixture, "x", fakeCtx({ result: { a: 1 } }))).result).toBeUndefined();
      expect(envelopeOf(await runEmit(fixture, "x?with=result", fakeCtx({ result: { a: 1 } }))).result).toEqual({ a: 1 });
      expect(envelopeOf(await runEmit(fixture, "x?with=result", fakeCtx())).result).toBeNull();
    });

    it("?with=result&other=1 still enables it, ?with=other does not", async () => {
      const fixture = await make();
      expect(envelopeOf(await runEmit(fixture, "x?with=result&other=1", fakeCtx({ result: { a: 1 } }))).result).toEqual({ a: 1 });
      expect(envelopeOf(await runEmit(fixture, "x?with=other", fakeCtx({ result: { a: 1 } }))).result).toBeUndefined();
    });

    it("delivers exactly once to a subscribed pipeline per emit", async () => {
      const fixture = await make();
      await fixture.raise("x.happened", { a: 1 });
      const delivered = await fixture.delivered();
      expect(delivered).toHaveLength(1);
    });

    it("every delivered event carries eventId, event and at; an emitter-supplied eventId is kept; no field is moved or dropped", async () => {
      const fixture = await make();
      await fixture.raise("x.happened", { a: 1 });
      const [first] = await fixture.delivered();
      expect(typeof first?.eventId).toBe("string");
      expect(first?.event).toBe("x.happened");
      expect(typeof first?.at).toBe("number");
      expect(first?.a).toBe(1);

      const other = await make();
      await other.raise("x.happened", { eventId: "given", a: 1 });
      const [second] = await other.delivered();
      expect(second?.eventId).toBe("given");
      expect(second?.a).toBe(1);
    });
  });
}
