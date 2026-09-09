import { describe, it, expect } from "vitest";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Context, StepResult } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import type { CoreCode, KestrelError } from "@michaelthielemann/kestrel/errors";
import { isOk, ok } from "@michaelthielemann/kestrel/result";
import type { RunResult, Runner } from "@michaelthielemann/kestrel/runner";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module from "./module.ts";
import { createEventsInmemory } from "./impl.ts";

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
    fail(codeOrError: CoreCode | KestrelError, message?: string): never {
      throw new Error(`${typeof codeOrError === "string" ? codeOrError : codeOrError.code} ${message ?? ""}`);
    },
    done: () => {
      throw new Error("done called");
    },
    ...overrides,
  };
}

describe("events/inmemory emit step", () => {
  it("logs and returns ctx unchanged when a handler throws", async () => {
    const errors: unknown[] = [];
    const logger: Logger = { step() {}, info() {}, error(message, meta) { errors.push({ message, meta }); } };
    const events = { ...createEventsInmemory(), logger };
    events.on("boom", async () => {
      throw new Error("handler failed");
    });

    const steps = module.steps!(events);
    const emit = (steps.emit as (name: string) => (ctx: Context) => Promise<StepResult>)("boom");
    const ctx = fakeCtx();

    const result = await emit(ctx);

    expect(isOk(result)).toBe(true);
    expect(isOk(result) && result.value).toBe(ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "events: handler failed", meta: { event: "boom" } });
  });

  it("sends an envelope without result by default, id from ctx.result.id", async () => {
    const noLogger: Logger = { step() {}, info() {}, error() {} };
    const events = { ...createEventsInmemory(), logger: noLogger };
    let received: unknown;
    events.on("page.created", async (_name, data) => { received = data; });

    const steps = module.steps!(events);
    const emit = (steps.emit as (spec: string) => (ctx: Context) => Promise<StepResult>)("page.created");
    await emit(fakeCtx({ params: { slug: "x" }, result: { id: "p1", title: "t" } }));

    expect(received).toEqual({ eventId: expect.any(String) as string, event: "page.created", at: expect.any(Number) as number, runId: "test", identity: null, params: { slug: "x" }, id: "p1" });
  });

  it("adds ids from a bulk result (result.ids), id stays null", async () => {
    const noLogger: Logger = { step() {}, info() {}, error() {} };
    const events = { ...createEventsInmemory(), logger: noLogger };
    let received: unknown;
    events.on("media.uploaded", async (_name, data) => { received = data; });

    const steps = module.steps!(events);
    const emit = (steps.emit as (spec: string) => (ctx: Context) => Promise<StepResult>)("media.uploaded");
    await emit(fakeCtx({ result: { items: [], errors: [], ids: ["a", "b"] } }));

    expect(received).toEqual({ eventId: expect.any(String) as string, event: "media.uploaded", at: expect.any(Number) as number, runId: "test", identity: null, params: {}, id: null, ids: ["a", "b"] });
  });

  it("takes the id from ctx.result.document.id when result is a { document } envelope", async () => {
    const noLogger: Logger = { step() {}, info() {}, error() {} };
    const events = { ...createEventsInmemory(), logger: noLogger };
    let received: unknown;
    events.on("page.updated", async (_name, data) => { received = data; });

    const steps = module.steps!(events);
    const emit = (steps.emit as (spec: string) => (ctx: Context) => Promise<StepResult>)("page.updated");
    await emit(fakeCtx({ result: { document: { id: "p2" }, delivery: { ok: true } } }));

    expect((received as { id: unknown }).id).toBe("p2");
    expect((received as Record<string, unknown>).result).toBeUndefined();
  });

  it("falls back to ctx.params.id when there is no result", async () => {
    const noLogger: Logger = { step() {}, info() {}, error() {} };
    const events = { ...createEventsInmemory(), logger: noLogger };
    let received: unknown;
    events.on("media.deleted", async (_name, data) => { received = data; });

    const steps = module.steps!(events);
    const emit = (steps.emit as (spec: string) => (ctx: Context) => Promise<StepResult>)("media.deleted");
    await emit(fakeCtx({ params: { id: "m1" } }));

    expect((received as { id: unknown }).id).toBe("m1");
  });

  it("falls back to null id when neither result nor params carry an id", async () => {
    const noLogger: Logger = { step() {}, info() {}, error() {} };
    const events = { ...createEventsInmemory(), logger: noLogger };
    let received: unknown;
    events.on("boot", async (_name, data) => { received = data; });

    const steps = module.steps!(events);
    const emit = (steps.emit as (spec: string) => (ctx: Context) => Promise<StepResult>)("boot");
    await emit(fakeCtx());

    expect((received as { id: unknown }).id).toBeNull();
  });

  it("stamps a fresh eventId and the emitting runId on every envelope", async () => {
    const noLogger: Logger = { step() {}, info() {}, error() {} };
    const events = { ...createEventsInmemory(), logger: noLogger };
    const received: Array<Record<string, unknown>> = [];
    events.on("page.created", async (_name, data) => { received.push(data); });

    const steps = module.steps!(events);
    const emit = (steps.emit as (spec: string) => (ctx: Context) => Promise<StepResult>)("page.created");
    await emit(fakeCtx({ runId: "run-a" }));
    await emit(fakeCtx({ runId: "run-b" }));

    expect(received.map((d) => d.runId)).toEqual(["run-a", "run-b"]);
    expect(received[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(received[0]?.eventId).not.toBe(received[1]?.eventId);
  });

  it("adds result verbatim when the step argument is ?with=result", async () => {
    const noLogger: Logger = { step() {}, info() {}, error() {} };
    const events = { ...createEventsInmemory(), logger: noLogger };
    let received: unknown;
    events.on("auth.loggedIn", async (_name, data) => { received = data; });

    const steps = module.steps!(events);
    const emit = (steps.emit as (spec: string) => (ctx: Context) => Promise<StepResult>)("auth.loggedIn?with=result");
    await emit(fakeCtx({ result: { token: "secret", identity: { id: "u1", claims: {} } } }));

    expect((received as Record<string, unknown>).event).toBe("auth.loggedIn");
    expect((received as Record<string, unknown>).result).toEqual({ token: "secret", identity: { id: "u1", claims: {} } });
  });
});

describe("events/inmemory event trigger hook", () => {
  const noLogger: Logger = { step() {}, info() {}, error() {} };
  const ok: RunResult = { runId: "r1", status: 200 };

  it("runs the configured pipeline on a matching event and stops unsubscribing", async () => {
    const events = { ...createEventsInmemory(), logger: noLogger };
    const runs: Array<{ pipeline: string; input: unknown }> = [];
    const run: Runner = async (pipeline, input) => {
      runs.push({ pipeline, input });
      return ok;
    };

    const stop = module.triggers!.event!(events, [{ event: "page.created", pipeline: "invalidateCache" }], run, noLogger);
    await events.emit("page.created", { id: "p1" });
    await events.emit("page.deleted", { id: "p1" });

    expect(runs).toEqual([{ pipeline: "invalidateCache", input: { trigger: { kind: "event", name: "page.created" }, payload: { id: "p1" } } }]);

    stop();
    await events.emit("page.created", { id: "p2" });
    expect(runs).toHaveLength(1);
  });

  it("passes the emitting runId to the handler pipeline as parentRunId", async () => {
    const events = { ...createEventsInmemory(), logger: noLogger };
    const inputs: unknown[] = [];
    const run: Runner = async (_pipeline, input) => {
      inputs.push(input);
      return ok;
    };

    const stop = module.triggers!.event!(events, [{ event: "page.created", pipeline: "invalidateCache" }], run, noLogger);
    await events.emit("page.created", { id: "p1", runId: "run-a" });
    await events.emit("page.created", { id: "p2" });
    stop();

    expect(inputs).toEqual([
      { trigger: { kind: "event", name: "page.created" }, payload: { id: "p1", runId: "run-a" }, parentRunId: "run-a" },
      { trigger: { kind: "event", name: "page.created" }, payload: { id: "p2" } },
    ]);
  });

  it("logs a failing pipeline run without rejecting the emit", async () => {
    const errors: unknown[] = [];
    const logger: Logger = { step() {}, info() {}, error(message, meta) { errors.push({ message, meta }); } };
    const events = { ...createEventsInmemory(), logger };
    const run: Runner = async () => ({ runId: "r2", status: 503, error: "boom", code: "TRANSIENT", retryable: true });

    const stop = module.triggers!.event!(events, [{ event: "page.created", pipeline: "invalidateCache" }], run, logger);
    await events.emit("page.created", {});
    stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'event "page.created" pipeline "invalidateCache" ended with 503', meta: { runId: "r2", error: "boom", code: "TRANSIENT", retryable: true } });
  });
});

async function makeInstance(): Promise<Events & { logger: Logger }> {
  return (await module.setup(module.configSchema.parse({}), {
    get: () => {
      throw new Error("no contract expected");
    },
    find: () => undefined,
    logger: silentLogger,
    root: process.cwd(),
  })) as Events & { logger: Logger };
}

function pipeline(...steps: string[]) {
  return definePipeline({ name: "test", steps });
}

describe("events/inmemory emit step via runPipeline", () => {
  it("registers the real step and describe(), and emits with id from a preceding step's result", async () => {
    const events = await makeInstance();
    let received: unknown;
    events.on("page.created", async (_name, data) => {
      received = data;
    });
    const seedResult = { "seed.result": async (ctx: Context) => ok({ ...ctx, result: { id: "p1", title: "t" } }) };

    const res = await runPipeline(pipeline("seed.result", "events.emit:page.created"), { params: { slug: "x" } }, { modules: [{ module, instance: events }], steps: seedResult });

    expect(res.status).toBe(200);
    expect(received).toMatchObject({ event: "page.created", id: "p1", params: { slug: "x" } });
  });
});
