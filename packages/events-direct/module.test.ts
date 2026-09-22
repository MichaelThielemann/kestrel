import { describe, it, expect } from "vitest";
import { eventDeliveryStepTests, type EventDeliveryFixture } from "@michaelthielemann/kestrel-contracts/events.steps.contract.test";
import type { EventData, Events } from "@michaelthielemann/kestrel-contracts/events";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context, StepResult } from "@michaelthielemann/kestrel/context";
import { failure, type CoreCode, type KestrelError } from "@michaelthielemann/kestrel/errors";
import type { RunResult, Runner } from "@michaelthielemann/kestrel/runner";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { err } from "@michaelthielemann/kestrel/result";
import { createEventsInmemory } from "@michaelthielemann/kestrel-events-inmemory/impl";
import module from "./module.ts";
import { createRelayReports, startEventTriggers } from "./impl.ts";

function fakeCtx(overrides: Partial<Context> = {}): Context {
  return {
    runId: "test",
    trigger: { kind: "http", name: "t" },
    payload: {},
    body: {},
    query: {},
    params: {},
    headers: {},
    files: [],
    fail(codeOrError: CoreCode | KestrelError, message?: string, details?: Record<string, unknown>) {
      if (typeof codeOrError !== "string") return err(codeOrError);
      return err(failure(codeOrError, message ?? "", details === undefined ? {} : { details }));
    },
    done: () => {
      throw new Error("done called");
    },
    ...overrides,
  };
}

function jsonCopy(value: unknown): EventData {
  return boundaryCast<EventData>(JSON.parse(JSON.stringify(value)), "json");
}

function eventDeliveryFixture(): EventDeliveryFixture {
  const bus = createEventsInmemory();
  const delivered: EventData[] = [];
  const spyBus: Events = {
    on: (name, handler) => bus.on(name, handler),
    async emit(name, data) {
      delivered.push(jsonCopy(data));
      await bus.emit(name, data);
    },
  };
  const run: Runner = async (_pipeline, input) => {
    delivered.push(jsonCopy(input.payload));
    return { runId: "r", status: 200 };
  };
  const instance = { bus: spyBus, reports: createRelayReports(), logger: silentLogger };
  startEventTriggers(bus, [{ event: "x.happened", pipeline: "onX1" }, { event: "x.happened", pipeline: "onX2" }], run, silentLogger, instance.reports);
  return {
    steps: module.steps!(instance),
    describe: module.describe!(instance),
    async raise(event, data) {
      await bus.emit(event, data);
    },
    async delivered() {
      return delivered;
    },
  };
}

eventDeliveryStepTests(async () => eventDeliveryFixture());

describe("events/direct emit step", () => {
  it("answers fail(INTERNAL) with cause when a subscribed handler throws", async () => {
    const bus = createEventsInmemory();
    bus.on("boom", async () => {
      throw new Error("handler failed");
    });

    const steps = module.steps!({ bus, reports: createRelayReports(), logger: silentLogger });
    const emit = boundaryCast<(name: string) => (ctx: Context) => Promise<StepResult>>(steps.emit, "host")("boom");
    const result = await emit(fakeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.status).toBe(500);
      expect(result.error.retryable).toBe(false);
      expect(result.error.cause).toBeInstanceOf(AggregateError);
    }
  });
});

describe("events/direct event trigger hook", () => {
  const noLogger: Logger = { step() {}, info() {}, error() {} };
  const ok: RunResult = { runId: "r1", status: 200 };

  it("runs the configured pipeline on a matching event and stops unsubscribing", async () => {
    const events = createEventsInmemory();
    const runs: Array<{ pipeline: string; input: unknown }> = [];
    const run: Runner = async (pipeline, input) => {
      runs.push({ pipeline, input });
      return ok;
    };

    const stop = startEventTriggers(events, [{ event: "page.created", pipeline: "invalidateCache" }], run, noLogger);
    await events.emit("page.created", { id: "p1" });
    await events.emit("page.deleted", { id: "p1" });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.pipeline).toBe("invalidateCache");

    stop();
    await events.emit("page.created", { id: "p2" });
    expect(runs).toHaveLength(1);
  });

  it("passes the emitting runId to the handler pipeline as parentRunId", async () => {
    const events = createEventsInmemory();
    const inputs: unknown[] = [];
    const run: Runner = async (_pipeline, input) => {
      inputs.push(input);
      return ok;
    };

    const stop = startEventTriggers(events, [{ event: "page.created", pipeline: "invalidateCache" }], run, noLogger);
    await events.emit("page.created", { id: "p1", runId: "run-a" });
    await events.emit("page.created", { id: "p2" });
    stop();

    expect(inputs).toMatchObject([{ trigger: { kind: "event", name: "page.created" }, parentRunId: "run-a" }, { trigger: { kind: "event", name: "page.created" } }]);
  });

  it("logs a failing pipeline run without rejecting the emit", async () => {
    const errors: unknown[] = [];
    const logger: Logger = { step() {}, info() {}, error(message, meta) { errors.push({ message, meta }); } };
    const events = createEventsInmemory();
    const run: Runner = async () => ({ runId: "r2", status: 503, error: "boom", code: "TRANSIENT", retryable: true });

    const stop = startEventTriggers(events, [{ event: "page.created", pipeline: "invalidateCache" }], run, logger);
    await events.emit("page.created", {});
    stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'event "page.created" pipeline "invalidateCache" ended with 503', meta: { runId: "r2", error: "boom", code: "TRANSIENT", retryable: true } });
  });

  it("isolates a throwing pipeline from the other pipeline subscribed to the same event", async () => {
    const errors: unknown[] = [];
    const logger: Logger = { step() {}, info() {}, error(message, meta) { errors.push({ message, meta }); } };
    const events = createEventsInmemory();
    const ran: string[] = [];
    const run: Runner = async (pipeline) => {
      ran.push(pipeline);
      if (pipeline === "first") throw new Error("boom");
      return ok;
    };

    const stop = startEventTriggers(events, [{ event: "page.created", pipeline: "first" }, { event: "page.created", pipeline: "second" }], run, logger);
    await expect(events.emit("page.created", {})).rejects.toThrow();
    stop();

    expect(ran).toEqual(["first", "second"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'event "page.created" pipeline "first" threw' });
  });

  it("runs the pipelines subscribed to one event one at a time, in registration order", async () => {
    const events = createEventsInmemory();
    const order: string[] = [];
    const run: Runner = async (pipeline) => {
      order.push(`${pipeline}:start`);
      if (pipeline === "first") await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${pipeline}:end`);
      return ok;
    };

    const stop = startEventTriggers(events, [{ event: "page.created", pipeline: "first" }, { event: "page.created", pipeline: "second" }], run, noLogger);
    await events.emit("page.created", {});
    stop();

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
