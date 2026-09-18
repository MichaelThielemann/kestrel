import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, silentLogger } from "@michaelthielemann/kestrel";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import type { Context } from "@michaelthielemann/kestrel/context";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import type { RunResult } from "@michaelthielemann/kestrel/runner";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { EventsQueue } from "./impl.ts";
import module, { configSchema } from "./module.ts";

async function setup(overrides: Record<string, unknown> = {}) {
  const db = createFakePersistence();
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (contract.name !== PERSISTENCE.name) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(db, "host");
    },
    find: () => undefined,
    logger: silentLogger,
    root: process.cwd(),
  };
  const instance = boundaryCast<EventsQueue>(await module.setup(configSchema.parse({ maxAttempts: 1, ...overrides }), deps), "host");
  return { db, instance };
}

function run(steps: string[], input: Record<string, unknown>, instance: unknown): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }] });
}

describe("events/queue module steps via runPipeline", () => {
  it("parses an empty config with defaults and rejects unknown keys", () => {
    expect(configSchema.parse({})).toEqual({ pollMs: 500, batch: 20, maxAttempts: 5, backoffSeconds: [5, 30, 120, 600], lockTtlSeconds: 300, retentionDays: 7 });
    expect(configSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("emit queues the envelope and answers ok before any handler ran", async () => {
    const { instance } = await setup();
    let calls = 0;
    instance.on("page.created", async () => {
      calls++;
    });
    const res = await run(["events.emit:page.created"], { params: { id: "p1" } }, instance);
    expect(res.status).toBe(200);
    expect(calls).toBe(0);
    expect(await instance.tick()).toBe(1);
    expect(calls).toBe(1);
  });

  it("emit fails with 503 TRANSIENT when the row cannot be persisted", async () => {
    const { db, instance } = await setup();
    db.failNext("TRANSIENT");
    const res = await run(["events.emit:page.created"], {}, instance);
    expect(res).toMatchObject({ status: 503, code: "TRANSIENT", step: "events.emit:page.created" });
  });

  it("readQueueStatus answers the counters", async () => {
    const { instance } = await setup();
    const res = await run(["events.readQueueStatus"], {}, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ pending: 0, running: 0, dead: 0, done24h: 0, oldestPendingAt: null, worker: { running: false, lastTickAt: null } });
  });

  it("listDead honours ?limit and rejects an invalid one", async () => {
    const { instance } = await setup();
    instance.on("x", async () => {
      throw new Error("no");
    });
    for (let i = 0; i < 3; i++) await run(["events.emit:x"], {}, instance);
    await instance.tick();
    const res = await run(["events.listDead"], { query: { limit: "2" } }, instance);
    expect(res.status).toBe(200);
    expect(boundaryCast<{ items: unknown[] }>(res.result, "json").items).toHaveLength(2);
    expect((await run(["events.listDead"], { query: { limit: "0" } }, instance)).status).toBe(400);
    expect(boundaryCast<{ items: unknown[] }>((await run(["events.listDead"], {}, instance)).result, "json").items).toHaveLength(3);
  });

  it("retryDead:one needs params.id, 404s an unknown id and requeues a dead event; retryDead:all requeues every one", async () => {
    const { instance } = await setup();
    instance.on("x", async () => {
      throw new Error("no");
    });
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
      describe: () => ({ create: { summary: "c", reads: [], writes: ["result"] }, listen: { summary: "l", reads: [], writes: [] } }),
    });
    const kestrel = await boot({
      config: {
        modules: [
          { use: "./persistence.ts", config: {} },
          { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 2 } },
          { use: "./probe.ts", config: {} },
        ],
        triggers: [
          { http: "POST /docs", pipeline: "createDoc" },
          { event: "doc.created", pipeline: "onCreated" },
        ],
        http: null,
      },
      modules: [persistence, module, probe],
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
});
