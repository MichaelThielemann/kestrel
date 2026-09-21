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

async function emitAndCapture(fixture: EventDeliveryFixture, spec: string, ctx: Context): Promise<Record<string, unknown>> {
  const emit = emitStepOf(fixture)(spec);
  const result: StepResult = await emit(ctx);
  if (!result.ok) throw new Error(`emit failed: ${result.error.code} ${result.error.message}`);
  const delivered = await fixture.delivered();
  const last = delivered[delivered.length - 1];
  if (last === undefined) throw new Error(`emit:${spec} produced no delivered envelope`);
  return boundaryCast<Record<string, unknown>>(last, "json");
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
      const envelope = await emitAndCapture(fixture, "page.created", fakeCtx());
      const after = Date.now();
      expect(Object.keys(envelope).sort()).toEqual(["at", "event", "eventId", "id", "identity", "params", "runId"]);
      expect(envelope.at).toBeGreaterThanOrEqual(before);
      expect(envelope.at).toBeLessThanOrEqual(after);
    });

    it("eventId is a distinct UUID per emit", async () => {
      const fixture = await make();
      const a = await emitAndCapture(fixture, "x", fakeCtx());
      const b = await emitAndCapture(fixture, "x", fakeCtx());
      expect(a.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(a.eventId).not.toBe(b.eventId);
    });

    it("event, runId, identity and params equal the emitting context's values", async () => {
      const fixture = await make();
      const identity = { id: "u1", claims: {} };
      const envelope = await emitAndCapture(fixture, "x.happened", fakeCtx({ runId: "run-a", identity, params: { slug: "s" } }));
      expect(envelope.event).toBe("x.happened");
      expect(envelope.runId).toBe("run-a");
      expect(envelope.identity).toEqual(identity);
      expect(envelope.params).toEqual({ slug: "s" });
    });

    it("derives id from result.id, result.document.id, params.id or null, in that order", async () => {
      const fixture = await make();
      expect((await emitAndCapture(fixture, "x", fakeCtx({ params: { id: "from-params" }, result: { id: "from-result" } }))).id).toBe("from-result");
      expect((await emitAndCapture(fixture, "x", fakeCtx({ result: { document: { id: "from-document" } } }))).id).toBe("from-document");
      expect((await emitAndCapture(fixture, "x", fakeCtx({ params: { id: "from-params" } }))).id).toBe("from-params");
      expect((await emitAndCapture(fixture, "x", fakeCtx())).id).toBeNull();
    });

    it("ids appears only for an all-string result.ids array", async () => {
      const fixture = await make();
      expect((await emitAndCapture(fixture, "x", fakeCtx({ result: { ids: ["a", "b"] } }))).ids).toEqual(["a", "b"]);
      expect((await emitAndCapture(fixture, "x", fakeCtx({ result: { ids: ["a", 1] } }))).ids).toBeUndefined();
    });

    it("result is absent without ?with=result, present with it, null when ctx.result is undefined", async () => {
      const fixture = await make();
      expect((await emitAndCapture(fixture, "x", fakeCtx({ result: { a: 1 } }))).result).toBeUndefined();
      expect((await emitAndCapture(fixture, "x?with=result", fakeCtx({ result: { a: 1 } }))).result).toEqual({ a: 1 });
      expect((await emitAndCapture(fixture, "x?with=result", fakeCtx())).result).toBeNull();
    });

    it("?with=result&other=1 still enables it, ?with=other does not", async () => {
      const fixture = await make();
      expect((await emitAndCapture(fixture, "x?with=result&other=1", fakeCtx({ result: { a: 1 } }))).result).toEqual({ a: 1 });
      expect((await emitAndCapture(fixture, "x?with=other", fakeCtx({ result: { a: 1 } }))).result).toBeUndefined();
    });

    it("delivers exactly once to each of the two pipelines subscribed to one event, per emit", async () => {
      const fixture = await make();
      await fixture.raise("x.happened", { a: 1 });
      const delivered = await fixture.delivered();
      expect(delivered).toHaveLength(2);
      for (const entry of delivered) expect(entry.a).toBe(1);
    });

    it("every delivered event carries eventId, event and at; an emitter-supplied eventId is kept; no field is moved or dropped", async () => {
      const fixture = await make();
      await fixture.raise("x.happened", { a: 1 });
      const [first, second] = await fixture.delivered();
      for (const entry of [first, second]) {
        expect(typeof entry?.eventId).toBe("string");
        expect(entry?.event).toBe("x.happened");
        expect(typeof entry?.at).toBe("number");
        expect(entry?.a).toBe(1);
      }

      const other = await make();
      await other.raise("x.happened", { eventId: "given", a: 1 });
      for (const entry of await other.delivered()) {
        expect(entry.eventId).toBe("given");
        expect(entry.a).toBe(1);
      }
    });
  });
}
