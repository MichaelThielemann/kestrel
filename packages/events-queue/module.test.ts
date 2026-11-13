import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, KestrelBootError, silentLogger } from "@michaelthielemann/kestrel";
import { EVENTS, type EventData } from "@michaelthielemann/kestrel-contracts/events";
import { withEventIdentity } from "@michaelthielemann/kestrel-contracts/helpers/events.envelope";
import { eventDeliveryStepTests, type EventDeliveryFixture } from "@michaelthielemann/kestrel-contracts/events.steps.contract.test";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Context } from "@michaelthielemann/kestrel/context";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import type { RunResult, Runner } from "@michaelthielemann/kestrel/runner";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { createEventsInmemory } from "@michaelthielemann/kestrel-events-inmemory/impl";
import { createEventsQueue, QUEUE, type EventsQueue, type QueueRow } from "./impl.ts";
import module, { configSchema } from "./module.ts";

function jsonCopy(value: unknown): EventData {
  return boundaryCast<EventData>(JSON.parse(JSON.stringify(value)), "json");
}

async function eventDeliveryFixture(): Promise<EventDeliveryFixture> {
  const db = createFakePersistence();
  const queue = await createEventsQueue({ pollMs: 500, batch: 20, maxAttempts: 5, backoffSeconds: [5], lockTtlSeconds: 300, retentionDays: 7, relayMs: 5000, relayPipelines: "all", lanes: {}, delayMs: {} }, { db, logger: silentLogger });
  const deliveryEntries = [{ event: "x.happened", pipeline: "onX1" }, { event: "x.happened", pipeline: "onX2" }];
  queue.setDelivery(deliveryEntries, async () => ({ runId: "r", status: 200 }));
  const pipelineCountOf = (name: string) => deliveryEntries.filter((entry) => entry.event === name).length;
  const delivered: EventData[] = [];
  const spied: EventsQueue = {
    ...queue,
    async enqueue(name, data) {
      const copies = Math.max(1, pipelineCountOf(name));
      for (let i = 0; i < copies; i++) delivered.push(jsonCopy(data));
      await queue.enqueue(name, data);
    },
  };
  return {
    steps: module.steps!(spied),
    describe: module.describe!(spied),
    async raise(event, data) {
      await spied.enqueue(event, withEventIdentity(event, data));
    },
    async delivered() {
      return delivered;
    },
  };
}

eventDeliveryStepTests(eventDeliveryFixture);

const FAIL_RUN: Runner = async () => ({ runId: "r", status: 500, error: "no", code: "INTERNAL", retryable: false });

async function setup(overrides: Record<string, unknown> = {}, logger: Deps["logger"] = silentLogger) {
  const db = createFakePersistence();
  const bus = createEventsInmemory();
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (contract.name === PERSISTENCE.name) return boundaryCast<T>(db, "host");
      if (contract.name === EVENTS.name) return boundaryCast<T>(bus, "host");
      throw new Error(`no provider for "${contract.name}"`);
    },
    find: () => undefined,
    logger,
    root: process.cwd(),
    eventTriggers: [],
  };
  const instance = boundaryCast<EventsQueue>(await module.setup(configSchema.parse({ maxAttempts: 1, relayMs: 0, ...overrides }), deps), "host");
  return { db, bus, instance };
}

function run(steps: string[], input: Record<string, unknown>, instance: unknown): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }] });
}

describe("events/queue module shape", () => {
  it("does not provide events@1 and requires persistence@1 and events@1", () => {
    expect(module.provides).toEqual([]);
    expect(module.requires.map((c) => c.name).sort()).toEqual(["events@1", "persistence@1"]);
  });

  it("teardown stops the worker the hook started", async () => {
    const { instance } = await setup();
    module.triggers!.event!(instance, [{ event: "x", pipeline: "p1" }], async () => ({ runId: "r", status: 200 }), silentLogger);
    expect(instance.workerRunning()).toBe(true);
    await module.teardown!(instance);
    expect(instance.workerRunning()).toBe(false);
  });

  it("installs an empty delivery table and writes no row when no event trigger exists anywhere in the manifest", async () => {
    const logs: string[] = [];
    const spyLogger: Deps["logger"] = { step() {}, info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
    const { db, instance } = await setup({}, spyLogger);
    const res = await run(["events.emit:page.created"], {}, instance);
    expect(res.status).toBe(200);
    expect(expectOk(await db.count(QUEUE, {}))).toBe(0);
    expect(instance.workerRunning()).toBe(false);
    expect(logs).toEqual([]);
  });
});

describe("events/queue module steps via runPipeline", () => {
  it("parses an empty config with defaults and rejects unknown keys", () => {
    expect(configSchema.parse({})).toEqual({ pollMs: 500, batch: 20, maxAttempts: 5, backoffSeconds: [5, 30, 120, 600], lockTtlSeconds: 300, retentionDays: 7, relayMs: 5000, relayPipelines: "all", lanes: {}, delayMs: {} });
    expect(configSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("accepts delayMs as whole non-negative milliseconds per pipeline and rejects anything else", () => {
    expect(configSchema.safeParse({ delayMs: { refresh: 1000, other: 0 } }).success).toBe(true);
    expect(configSchema.safeParse({ delayMs: { refresh: -1 } }).success).toBe(false);
    expect(configSchema.safeParse({ delayMs: { refresh: 1.5 } }).success).toBe(false);
    expect(configSchema.safeParse({ delayMs: { refresh: "1000" } }).success).toBe(false);
  });

  it("rejects a malformed lane name and the reserved name \"main\"", () => {
    expect(configSchema.safeParse({ lanes: { Pages: ["x"] } }).success).toBe(false);
    expect(configSchema.safeParse({ lanes: { "0pages": ["x"] } }).success).toBe(false);
    expect(configSchema.safeParse({ lanes: { main: ["x"] } }).success).toBe(false);
    expect(configSchema.safeParse({ lanes: { pages: ["x"] } }).success).toBe(true);
  });

  it("emit queues the envelope and answers ok before the pipeline ran", async () => {
    const { instance } = await setup();
    let calls = 0;
    instance.setDelivery([{ event: "page.created", pipeline: "onCreated" }], async () => {
      calls++;
      return { runId: "r", status: 200 };
    });
    const res = await run(["events.emit:page.created"], { params: { id: "p1" } }, instance);
    expect(res.status).toBe(200);
    expect(calls).toBe(0);
    expect(await instance.tick()).toBe(1);
    expect(calls).toBe(1);
  });

  it("emit fails with 503 TRANSIENT when the row cannot be persisted", async () => {
    const { db, instance } = await setup();
    instance.setDelivery([{ event: "page.created", pipeline: "onCreated" }], async () => ({ runId: "r", status: 200 }));
    db.failNext("TRANSIENT");
    const res = await run(["events.emit:page.created"], {}, instance);
    expect(res).toMatchObject({ status: 503, code: "TRANSIENT", step: "events.emit:page.created" });
  });

  it("readQueueStatus answers the counters", async () => {
    const { instance } = await setup();
    const res = await run(["events.readQueueStatus"], {}, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ pending: 0, running: 0, dead: 0, done24h: 0, oldestPendingAt: null, worker: { running: false, lastTickAt: null }, lanes: {} });
  });

  it("listDead honours ?limit and rejects an invalid one", async () => {
    const { instance } = await setup();
    instance.setDelivery([{ event: "x", pipeline: "p" }], FAIL_RUN);
    for (let i = 0; i < 3; i++) await run(["events.emit:x"], {}, instance);
    await instance.tick();
    const res = await run(["events.listDead"], { query: { limit: "2" } }, instance);
    expect(res.status).toBe(200);
    expect(boundaryCast<{ items: unknown[] }>(res.result, "json").items).toHaveLength(2);
    expect((await run(["events.listDead"], { query: { limit: "0" } }, instance)).status).toBe(400);
    expect(boundaryCast<{ items: { pipeline: string }[] }>((await run(["events.listDead"], {}, instance)).result, "json").items).toMatchObject([{ pipeline: "p" }, { pipeline: "p" }, { pipeline: "p" }]);
  });

  it("retryDead:one needs params.id, 404s an unknown id and requeues a dead event; retryDead:all requeues every one", async () => {
    const { instance } = await setup();
    instance.setDelivery([{ event: "x", pipeline: "p" }], FAIL_RUN);
    await run(["events.emit:x"], {}, instance);
    await run(["events.emit:x"], {}, instance);
    await instance.tick();
    const dead = boundaryCast<{ items: { id: string }[] }>((await run(["events.listDead"], {}, instance)).result, "json").items;
    expect(await run(["events.retryDead:one"], {}, instance)).toMatchObject({ status: 400 });
    expect(await run(["events.retryDead:one"], { params: { id: "nope" } }, instance)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect((await run(["events.retryDead:one"], { params: { id: dead[0]!.id } }, instance)).result).toEqual({ retried: 1 });
    expect((await run(["events.retryDead:all"], {}, instance)).result).toEqual({ retried: 1 });
    expect((await run(["events.readQueueStatus"], {}, instance)).result).toMatchObject({ pending: 2, dead: 0 });
  });

  it("purgeDone reports the removed rows", async () => {
    const { instance } = await setup();
    const res = await run(["events.purgeDone"], {}, instance);
    expect(res.result).toEqual({ removed: 0 });
  });

  it("rejects an unknown retryDead argument at boot", () => {
    expect(() => run(["events.retryDead:some"], {}, undefined)).toThrow('"all" or "one"');
  });

  it("is a wiring error when the result is neither an object nor undefined", async () => {
    const { instance } = await setup();
    const pipeline = definePipeline({ name: "arrayResult", steps: ["seed.array", "events.relay"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }], steps: { "seed.array": async (ctx: Context) => ok({ ...ctx, result: [1, 2, 3] }) } });
    expect(result.status).toBe(500);
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("events/queue: cannot add _events to a non-object result");
  });
});

describe("events/queue in a booted instance", () => {
  const persistence = defineModule({
    name: "persistence/fake",
    provides: [PERSISTENCE],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return createFakePersistence();
    },
    atomicScope: (db, info, body) => boundaryCast<ReturnType<typeof createFakePersistence>>(db, "host").scope(info, body),
  });
  const bus = defineModule({
    name: "events/fake",
    provides: [EVENTS],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return createEventsInmemory();
    },
  });

  it("runs the listener pipeline from the worker after the emitting run finished, with the event trigger and parentRunId", async () => {
    const order: string[] = [];
    let seen: Context | undefined;
    const probe = defineModule({
      name: "probe/test",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({
        create: async (ctx: Context) => {
          order.push("create");
          return ok({ ...ctx, result: { id: "doc-1" } });
        },
        listen: async (ctx: Context) => {
          order.push("listen");
          seen = ctx;
          return ok(ctx);
        },
      }),
      describe: () => ({ create: { summary: "c", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, listen: { summary: "l", reads: [], writes: [] } }),
    });
    const kestrel = await boot({
      config: {
        modules: [
          { use: "./persistence.ts", config: {} },
          { use: "./events.ts", config: {} },
          { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 2, relayMs: 0 } },
          { use: "./probe.ts", config: {} },
        ],
        triggers: [
          { http: "POST /docs", pipeline: "createDoc" },
          { event: "doc.created", pipeline: "onCreated" },
        ],
        http: null,
      },
      modules: [persistence, bus, module, probe],
      pipelines: [definePipeline({ name: "createDoc", steps: ["probe.create", "events.emit:doc.created"] }), definePipeline({ name: "onCreated", steps: ["probe.listen"] })],
      logger: silentLogger,
    });
    await kestrel.start();
    const res = await kestrel.run("createDoc", { trigger: { kind: "http", name: "POST /docs" } });
    expect(res.status).toBe(200);
    expect(order).toEqual(["create"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["create", "listen"]);
    expect(seen?.trigger).toEqual({ kind: "event", name: "doc.created" });
    expect(seen?.payload).toMatchObject({ event: "doc.created", id: "doc-1", runId: res.runId });
    await kestrel.stop();
  });

  it("queues a contract-level events@1 emit, and a failed insert rejects it with an AggregateError", async () => {
    const db = createFakePersistence();
    const persistenceCapturing = defineModule({
      name: "persistence/fake",
      provides: [PERSISTENCE],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return db;
      },
    });
    const migrationsLike = defineModule({
      name: "migrations/fake",
      provides: [],
      requires: [PERSISTENCE, EVENTS],
      configSchema: z.object({}).strict(),
      emits: ["migrations.applied"],
      async setup(_config, deps): Promise<null> {
        await deps.get(EVENTS).emit("migrations.applied", { migrations: ["1"] });
        return null;
      },
    });
    const onMigrated = definePipeline({ name: "onMigrated", steps: ["probe.noop"] });
    const probe = defineModule({
      name: "probe/noop",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ noop: async (ctx: Context) => ok(ctx) }),
      describe: () => ({ noop: { summary: "n", reads: [], writes: [] } }),
    });
    const bootConfig = {
      config: { modules: [{ use: "./persistence.ts", config: {} }, { use: "./events.ts", config: {} }, { use: "@michaelthielemann/kestrel-events-queue", config: {} }, { use: "./migrations.ts", config: {} }, { use: "./probe.ts", config: {} }], triggers: [{ event: "migrations.applied", pipeline: "onMigrated" }], http: null },
      modules: [persistenceCapturing, bus, module, migrationsLike, probe],
      pipelines: [onMigrated],
      logger: silentLogger,
    };
    const kestrel = await boot(bootConfig);
    expect(expectOk(await db.count("events_queue", { name: "migrations.applied" }))).toBe(1);

    const liveBus = kestrel.contracts.get(EVENTS);
    db.failNext("TRANSIENT");
    let caught: unknown;
    try {
      await liveBus.emit("migrations.applied", { migrations: ["2"] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    if (caught instanceof AggregateError) {
      expect(caught.errors).toHaveLength(1);
      expect(String(caught.errors[0])).toMatch(/events\/queue: cannot persist event/);
    }
    expect(expectOk(await db.count("events_queue", { name: "migrations.applied" }))).toBe(1);

    await kestrel.stop();
  });

  it("ctx.done() before the relay skips it; the row stays pending for the worker until relayMs passes", async () => {
    const db = createFakePersistence();
    const persistenceCapturing = defineModule({
      name: "persistence/fake",
      provides: [PERSISTENCE],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return db;
      },
      atomicScope: (instance, info, body) => boundaryCast<typeof db>(instance, "host").scope(info, body),
    });
    let onCreatedRuns = 0;
    const probe = defineModule({
      name: "probe/test",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({
        create: async (ctx: Context) => ok({ ...ctx, result: { id: "doc-1" } }),
        stop: async (ctx: Context) => ctx.done(ctx.result),
        listen: async (ctx: Context) => {
          onCreatedRuns++;
          return ok(ctx);
        },
      }),
      describe: () => ({
        create: { summary: "c", reads: [], writes: ["result"], atomicSafe: true, output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        stop: { summary: "s", reads: ["result"], writes: ["result?"], atomicSafe: true, terminalOutput: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        listen: { summary: "l", reads: [], writes: [] },
      }),
    });
    const kestrel = await boot({
      config: {
        modules: [
          { use: "./persistence.ts", config: {} },
          { use: "./events.ts", config: {} },
          { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 5, relayMs: 20 } },
          { use: "./probe.ts", config: {} },
        ],
        triggers: [{ http: "POST /docs", pipeline: "createDoc" }, { event: "doc.created", pipeline: "onCreated" }],
        http: null,
      },
      modules: [persistenceCapturing, bus, module, probe],
      pipelines: [
        definePipeline({ name: "createDoc", steps: [{ atomic: ["probe.create", "events.emit:doc.created", "probe.stop"] }, "events.relay"] }),
        definePipeline({ name: "onCreated", steps: ["probe.listen"] }),
      ],
      logger: silentLogger,
    });
    await kestrel.start();
    const res = await kestrel.run("createDoc", { trigger: { kind: "http", name: "POST /docs" } });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ id: "doc-1" });
    expect(onCreatedRuns).toBe(0);

    const rowsRightAfter = expectOk(await db.findMany<QueueRow>("events_queue", { name: "doc.created" }));
    expect(rowsRightAfter.items).toMatchObject([{ state: "pending" }]);

    await new Promise((r) => setTimeout(r, 5));
    expect(onCreatedRuns).toBe(0);

    await new Promise((r) => setTimeout(r, 40));
    expect(onCreatedRuns).toBe(1);
    const rowsAfterWorker = expectOk(await db.findMany<QueueRow>("events_queue", { name: "doc.created" }));
    expect(rowsAfterWorker.items).toMatchObject([{ state: "done" }]);

    await kestrel.stop();
  });

  it("relayPipelines delivers the named pipeline in-request and leaves the other queued for the worker", async () => {
    const db = createFakePersistence();
    const persistenceCapturing = defineModule({
      name: "persistence/fake",
      provides: [PERSISTENCE],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return db;
      },
    });
    let aRuns = 0;
    let bRuns = 0;
    const probe = defineModule({
      name: "probe/test",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({
        create: async (ctx: Context) => ok({ ...ctx, result: { id: "doc-1" } }),
        listenA: async (ctx: Context) => {
          aRuns++;
          return ok(ctx);
        },
        listenB: async (ctx: Context) => {
          bRuns++;
          return ok(ctx);
        },
      }),
      describe: () => ({
        create: { summary: "c", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        listenA: { summary: "a", reads: [], writes: [] },
        listenB: { summary: "b", reads: [], writes: [] },
      }),
    });
    const kestrel = await boot({
      config: {
        modules: [
          { use: "./persistence.ts", config: {} },
          { use: "./events.ts", config: {} },
          { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 5, relayMs: 1000, relayPipelines: ["onCreatedA"] } },
          { use: "./probe.ts", config: {} },
        ],
        triggers: [
          { http: "POST /docs", pipeline: "createDoc" },
          { event: "doc.created", pipeline: "onCreatedA" },
          { event: "doc.created", pipeline: "onCreatedB" },
        ],
        http: null,
      },
      modules: [persistenceCapturing, bus, module, probe],
      pipelines: [
        definePipeline({ name: "createDoc", steps: ["probe.create", "events.emit:doc.created", "events.relay"] }),
        definePipeline({ name: "onCreatedA", steps: ["probe.listenA"] }),
        definePipeline({ name: "onCreatedB", steps: ["probe.listenB"] }),
      ],
      logger: silentLogger,
    });
    await kestrel.start();
    const res = await kestrel.run("createDoc", { trigger: { kind: "http", name: "POST /docs" } });
    expect(res.status).toBe(200);
    expect(aRuns).toBe(1);
    expect(bRuns).toBe(0);
    const body = boundaryCast<{ _events: { status: string; pipelines: unknown[] } }>(res.result, "json");
    expect(body._events.status).toBe("pending");
    expect(body._events.pipelines).toContainEqual({ event: "doc.created", pipeline: "onCreatedA", status: "done", attempts: 0, dead: false, error: null });
    expect(body._events.pipelines).toContainEqual({ event: "doc.created", pipeline: "onCreatedB", status: "queued", attempts: 0, dead: false, error: null });

    await new Promise((r) => setTimeout(r, 30));
    expect(bRuns).toBe(1);

    await kestrel.stop();
  });

  it("a dead-letter row leaves the instance healthy", async () => {
    const db = createFakePersistence();
    const persistenceCapturing = defineModule({
      name: "persistence/fake",
      provides: [PERSISTENCE],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return db;
      },
    });
    const probe = defineModule({
      name: "probe/fail",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ boom: async (ctx: Context) => ctx.fail("NOT_FOUND", "gone") }),
      describe: () => ({ boom: { summary: "fails on purpose", reads: [], writes: [] } }),
    });
    const kestrel = await boot({
      config: {
        modules: [
          { use: "./persistence.ts", config: {} },
          { use: "./events.ts", config: {} },
          { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 2, relayMs: 0, maxAttempts: 1 } },
          { use: "./probe.ts", config: {} },
        ],
        triggers: [{ http: "POST /docs", pipeline: "createDoc" }, { event: "doc.created", pipeline: "onCreated" }],
        http: null,
      },
      modules: [persistenceCapturing, bus, module, probe],
      pipelines: [definePipeline({ name: "createDoc", steps: ["events.emit:doc.created", "events.relay"] }), definePipeline({ name: "onCreated", steps: ["probe.boom"] }), definePipeline({ name: "status", steps: ["events.readDeliveryStatus"] })],
      logger: silentLogger,
    });
    await kestrel.start();
    const res = await kestrel.run("createDoc", { trigger: { kind: "http", name: "POST /docs" } });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 30));
    const status = await kestrel.run("status", { trigger: { kind: "http", name: "GET /status" } });
    expect(status.result).toMatchObject({ dead: 1 });
    expect(kestrel.health()).toEqual({ ok: true, restartRequired: false, modules: [] });

    await kestrel.stop();
  });

  it("relayPipelines naming an unknown pipeline fails boot with a clear message", async () => {
    const persistenceFake = defineModule({
      name: "persistence/fake",
      provides: [PERSISTENCE],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return createFakePersistence();
      },
    });
    const probe = defineModule({
      name: "probe/test",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ create: async (ctx: Context) => ok({ ...ctx, result: { id: "doc-1" } }) }),
      describe: () => ({ create: { summary: "c", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } }),
    });
    const bootConfig = {
      config: {
        modules: [
          { use: "./persistence.ts", config: {} },
          { use: "./events.ts", config: {} },
          { use: "@michaelthielemann/kestrel-events-queue", config: { relayPipelines: ["notAPipeline"] } },
          { use: "./probe.ts", config: {} },
        ],
        triggers: [{ http: "POST /docs", pipeline: "createDoc" }, { event: "doc.created", pipeline: "onCreated" }],
        http: null,
      },
      modules: [persistenceFake, bus, module, probe],
      pipelines: [definePipeline({ name: "createDoc", steps: ["probe.create"] }), definePipeline({ name: "onCreated", steps: ["probe.create"] })],
      logger: silentLogger,
    };
    let caught: unknown;
    try {
      await boot(bootConfig);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("relayPipelines");
    expect(String(caught)).toContain("notAPipeline");
  });

  it("a booted instance: a lane pipeline's job runs while a blocked main-lane job is still pending", async () => {
    const order: string[] = [];
    let releaseMain: (() => void) | undefined;
    const mainGate = new Promise<void>((r) => {
      releaseMain = r;
    });
    const probe = defineModule({
      name: "probe/test",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({
        blockMain: async (ctx: Context) => {
          order.push("start:main");
          await mainGate;
          order.push("done:main");
          return ok(ctx);
        },
        quick: async (ctx: Context) => {
          order.push("lane");
          return ok(ctx);
        },
      }),
      describe: () => ({ blockMain: { summary: "b", reads: [], writes: [] }, quick: { summary: "q", reads: [], writes: [] } }),
    });
    const kestrel = await boot({
      config: {
        modules: [
          { use: "./persistence.ts", config: {} },
          { use: "./events.ts", config: {} },
          { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 2, relayMs: 0, lanes: { render: ["onRender"] } } },
          { use: "./probe.ts", config: {} },
        ],
        triggers: [{ event: "main.due", pipeline: "onMain" }, { event: "render.due", pipeline: "onRender" }],
        http: null,
      },
      modules: [persistence, bus, module, probe],
      pipelines: [definePipeline({ name: "onMain", steps: ["probe.blockMain"] }), definePipeline({ name: "onRender", steps: ["probe.quick"] })],
      logger: silentLogger,
    });
    await kestrel.start();
    const eventsBus = kestrel.contracts.get(EVENTS);
    await eventsBus.emit("main.due", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start:main"]);

    await eventsBus.emit("render.due", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start:main", "lane"]);

    releaseMain?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start:main", "lane", "done:main"]);

    await kestrel.stop();
  });
});

describe("events/queue lanes and delays: attach guards", () => {
  const persistenceFakeForLanes = defineModule({
    name: "persistence/fake",
    provides: [PERSISTENCE],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return createFakePersistence();
    },
  });
  const busForLanes = defineModule({
    name: "events/fake",
    provides: [EVENTS],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return createEventsInmemory();
    },
  });
  const probeForLanes = defineModule({
    name: "probe/test",
    provides: [],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return {};
    },
    steps: () => ({ render: async (ctx: Context) => ok(ctx), plan: async (ctx: Context) => ok(ctx) }),
    describe: () => ({ render: { summary: "r", reads: [], writes: [] }, plan: { summary: "p", reads: [], writes: [] } }),
  });

  function bootWithLanes(lanes: Record<string, string[]>, relayPipelines?: string[] | "all", delayMs?: Record<string, number>) {
    return boot({
      config: {
        modules: [
          { use: "./persistence.ts", config: {} },
          { use: "./events.ts", config: {} },
          { use: "@michaelthielemann/kestrel-events-queue", config: { lanes, ...(relayPipelines === undefined ? {} : { relayPipelines }), ...(delayMs === undefined ? {} : { delayMs }) } },
          { use: "./probe.ts", config: {} },
        ],
        triggers: [{ event: "render.due", pipeline: "onRender" }, { event: "plan.due", pipeline: "onPlan" }],
        http: null,
      },
      modules: [persistenceFakeForLanes, busForLanes, module, probeForLanes],
      pipelines: [definePipeline({ name: "onRender", steps: ["probe.render"] }), definePipeline({ name: "onPlan", steps: ["probe.plan"] }), definePipeline({ name: "renderNow", steps: ["probe.render"] })],
      logger: silentLogger,
    });
  }

  async function bootError(booting: Promise<unknown>): Promise<unknown> {
    try {
      await booting;
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("refuses a lane naming an unknown pipeline", async () => {
    let caught: unknown;
    try {
      await bootWithLanes({ pages: ["notAPipeline"] });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("pages");
    expect(String(caught)).toContain("notAPipeline");
  });

  it("refuses a pipeline in two lanes", async () => {
    let caught: unknown;
    try {
      await bootWithLanes({ pages: ["onRender"], variants: ["onRender"] });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("onRender");
    expect(String(caught)).toContain("two lanes");
  });

  it("refuses a pipeline that is in a lane and named in relayPipelines", async () => {
    let caught: unknown;
    try {
      await bootWithLanes({ pages: ["onRender"] }, ["onRender"]);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("onRender");
    expect(String(caught)).toContain("relayPipelines");
  });

  it("refuses a lane naming a pipeline no event trigger runs, saying so", async () => {
    const caught = await bootError(bootWithLanes({ pages: ["renderNow"] }));
    expect(caught).toBeInstanceOf(KestrelBootError);
    expect(caught).toMatchObject({ code: "attach-failed", module: "events/queue" });
    expect(String(caught)).toContain('lane "pages"');
    expect(String(caught)).toContain('"renderNow"');
    expect(String(caught)).toContain("no event trigger");
  });

  it("refuses relayPipelines naming a pipeline no event trigger runs, saying so", async () => {
    const caught = await bootError(bootWithLanes({}, ["onRender", "renderNow"]));
    expect(caught).toBeInstanceOf(KestrelBootError);
    expect(caught).toMatchObject({ code: "attach-failed", module: "events/queue" });
    expect(String(caught)).toContain("relayPipelines");
    expect(String(caught)).toContain("renderNow");
    expect(String(caught)).not.toContain("onRender");
    expect(String(caught)).toContain("no event trigger");
  });

  it("boots with relayPipelines and lanes naming only pipelines an event trigger runs", async () => {
    const kestrel = await bootWithLanes({ pages: ["onPlan"] }, ["onRender"]);
    await kestrel.stop();
  });

  it("boots fine with a lane pipeline and the default relayPipelines (\"all\")", async () => {
    const kestrel = await bootWithLanes({ pages: ["onRender"] });
    await kestrel.stop();
  });

  it("refuses delayMs naming an unknown pipeline", async () => {
    const caught = await bootError(bootWithLanes({}, undefined, { notAPipeline: 1000 }));
    expect(caught).toMatchObject({ code: "attach-failed", module: "events/queue" });
    expect(String(caught)).toContain("delayMs");
    expect(String(caught)).toContain("notAPipeline");
    expect(String(caught)).toContain("unknown");
  });

  it("refuses delayMs naming a pipeline no event trigger runs, saying so", async () => {
    const caught = await bootError(bootWithLanes({}, undefined, { onRender: 1000, renderNow: 1000 }));
    expect(caught).toMatchObject({ code: "attach-failed", module: "events/queue" });
    expect(String(caught)).toContain("delayMs");
    expect(String(caught)).toContain("renderNow");
    expect(String(caught)).not.toContain("onRender");
    expect(String(caught)).toContain("no event trigger");
  });

  it("refuses a delayed pipeline that is also named in relayPipelines", async () => {
    const caught = await bootError(bootWithLanes({}, ["onRender"], { onRender: 1000 }));
    expect(caught).toMatchObject({ code: "attach-failed", module: "events/queue" });
    expect(String(caught)).toContain("onRender");
    expect(String(caught)).toContain("delayMs");
    expect(String(caught)).toContain("relayPipelines");
  });

  it("boots with a delayed pipeline, in a lane or not, and the default relayPipelines (\"all\")", async () => {
    const kestrel = await bootWithLanes({ indexes: ["onRender"] }, undefined, { onRender: 1000, onPlan: 3000 });
    await kestrel.stop();
  });

  it("boots with a zero delay on a pipeline named in relayPipelines, since a zero delay changes nothing", async () => {
    const kestrel = await bootWithLanes({}, ["onRender"], { onRender: 0 });
    await kestrel.stop();
  });
});

describe("events/queue: atomicSafe is pinned", () => {
  it("every step is atomic-safe, except relay, which runs whole pipelines and cannot be", async () => {
    const { instance } = await setup();
    const describeMap = module.describe!(instance);
    const notAtomicSafe = new Set(["relay"]);
    for (const [name, description] of Object.entries(describeMap)) {
      const resolved = typeof description === "function" ? description("one") : description;
      expect(resolved.atomicSafe, `${name}.atomicSafe`).toBe(notAtomicSafe.has(name) ? undefined : true);
    }
  });
});
