import { describe, expect, it } from "vitest";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err } from "@michaelthielemann/kestrel/result";
import type { RunResult, Runner } from "@michaelthielemann/kestrel/runner";
import { createEventsQueue, QUEUE, QueueWriteError, retryTarget, type Config, type QueueRow } from "./impl.ts";

const CONFIG: Config = { pollMs: 5, batch: 2, maxAttempts: 3, backoffSeconds: [10, 100], lockTtlSeconds: 60, retentionDays: 1 };

async function make(overrides: Partial<Config> = {}) {
  const db = createFakePersistence();
  const clock = { t: 1_000_000 };
  const queue = await createEventsQueue({ ...CONFIG, ...overrides }, { db, logger: silentLogger, now: () => clock.t, instanceId: "test@host" });
  const rows = async () => expectOk(await db.findMany<QueueRow>(QUEUE, {}, { sort: { createdAt: "asc" } })).items;
  return { db, clock, queue, rows };
}

const OK: RunResult = { runId: "r", status: 200 };

describe("events/queue enqueue", () => {
  it("writes one row per pipeline subscribed to the event", async () => {
    const { queue, rows } = await make();
    const run: Runner = async () => OK;
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], run);
    await queue.enqueue("x", { id: "1" });
    expect(await rows()).toMatchObject([
      { name: "x", pipeline: "p1", payload: { id: "1" }, state: "pending", attempts: 0, availableAt: 1_000_000 },
      { name: "x", pipeline: "p2", payload: { id: "1" }, state: "pending", attempts: 0, availableAt: 1_000_000 },
    ]);
  });

  it("writes nothing when delivery is installed but nobody subscribes to the event", async () => {
    const { queue, rows } = await make();
    queue.setDelivery([], async () => OK);
    await queue.enqueue("nobody", {});
    expect(await rows()).toEqual([]);
  });

  it("writes one unfanned row when the delivery table is not installed yet", async () => {
    const { queue, rows } = await make();
    await queue.enqueue("x", { id: "1" });
    expect(await rows()).toMatchObject([{ name: "x", pipeline: null, state: "pending" }]);
  });

  it("rejects with QueueWriteError when the row cannot be written", async () => {
    const { db, queue } = await make();
    db.failNext("TRANSIENT");
    await expect(queue.enqueue("x", {})).rejects.toBeInstanceOf(QueueWriteError);
  });
});

describe("events/queue worker", () => {
  it("delivers a frozen-shape row to its own pipeline via run() and marks it done", async () => {
    const { queue, rows } = await make();
    const seen: unknown[] = [];
    const run: Runner = async (pipeline, input) => {
      seen.push({ pipeline, input });
      return OK;
    };
    queue.setDelivery([{ event: "x", pipeline: "p1" }], run);
    await queue.enqueue("x", { id: "1" });
    expect(await queue.tick()).toBe(1);
    expect(seen).toEqual([{ pipeline: "p1", input: { trigger: { kind: "event", name: "x" }, payload: { id: "1" } } }]);
    expect(await rows()).toMatchObject([{ state: "done", attempts: 0, finishedAt: 1_000_000, lockedAt: null, lockedBy: null }]);
  });

  it("two pipelines on one event become two rows with distinct pipeline", async () => {
    const { queue, rows } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async () => OK);
    await queue.enqueue("x", {});
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.pipeline).sort()).toEqual(["p1", "p2"]);
  });

  it("retries and dead-letter are counted per pipeline, not per event", async () => {
    const { queue, clock, rows } = await make({ maxAttempts: 2 });
    let goodRuns = 0;
    let badRuns = 0;
    const run: Runner = async (pipeline) => {
      if (pipeline === "good") {
        goodRuns++;
        return OK;
      }
      badRuns++;
      return { runId: "r", status: 500, error: "bad", code: "INTERNAL", retryable: false };
    };
    queue.setDelivery([{ event: "x", pipeline: "good" }, { event: "x", pipeline: "bad" }], run);
    await queue.enqueue("x", {});
    await queue.tick();
    let stored = await rows();
    expect(stored.find((r) => r.pipeline === "good")).toMatchObject({ state: "done", attempts: 0 });
    expect(stored.find((r) => r.pipeline === "bad")).toMatchObject({ state: "pending", attempts: 1, error: "bad" });
    expect(goodRuns).toBe(1);
    expect(badRuns).toBe(1);

    clock.t += 200_000;
    await queue.tick();
    stored = await rows();
    expect(stored.find((r) => r.pipeline === "good")).toMatchObject({ state: "done", attempts: 0 });
    expect(stored.find((r) => r.pipeline === "bad")).toMatchObject({ state: "dead", attempts: 2, error: "bad" });
    expect(goodRuns).toBe(1);
    expect(badRuns).toBe(2);
  });

  it("a redelivered row carries the same eventId on every attempt", async () => {
    const { queue, clock } = await make();
    const seenIds: unknown[] = [];
    const run: Runner = async (_pipeline, input) => {
      seenIds.push(input.payload?.eventId);
      return seenIds.length === 1 ? { runId: "r", status: 500, error: "fail", code: "INTERNAL", retryable: false } : OK;
    };
    queue.setDelivery([{ event: "x", pipeline: "p1" }], run);
    await queue.enqueue("x", { eventId: "fixed-id" });
    await queue.tick();
    clock.t += 10_000;
    await queue.tick();
    expect(seenIds).toEqual(["fixed-id", "fixed-id"]);
  });

  it("retries with backoff and ends done after a pipeline fails twice", async () => {
    const { queue, clock, rows } = await make();
    let calls = 0;
    const run: Runner = async () => {
      calls++;
      return calls <= 2 ? { runId: "r", status: 500, error: `fail ${calls}`, code: "INTERNAL", retryable: false } : OK;
    };
    queue.setDelivery([{ event: "x", pipeline: "p1" }], run);
    await queue.enqueue("x", {});
    await queue.tick();
    expect(await rows()).toMatchObject([{ state: "pending", attempts: 1, availableAt: 1_010_000, error: "fail 1" }]);
    expect(await queue.tick()).toBe(0);
    clock.t = 1_010_000;
    await queue.tick();
    expect(await rows()).toMatchObject([{ state: "pending", attempts: 2, availableAt: 1_110_000, error: "fail 2" }]);
    clock.t = 1_110_000;
    await queue.tick();
    expect(await rows()).toMatchObject([{ state: "done", attempts: 2, error: null }]);
    expect(calls).toBe(3);
  });

  it("moves a row to dead after maxAttempts failures, keeping the last error", async () => {
    const { queue, clock, rows } = await make();
    const run: Runner = async () => ({ runId: "r", status: 500, error: "always", code: "INTERNAL", retryable: false });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], run);
    await queue.enqueue("x", {});
    for (let i = 0; i < 3; i++) {
      clock.t += 200_000;
      await queue.tick();
    }
    expect(await rows()).toMatchObject([{ state: "dead", attempts: 3, error: "always" }]);
    expect(expectOk(await queue.listDead(10)).items).toMatchObject([{ name: "x", pipeline: "p1", attempts: 3, error: "always" }]);
  });

  it("claims at most batch rows per tick, oldest first", async () => {
    const { queue, clock, rows } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    for (const id of ["1", "2", "3"]) {
      await queue.enqueue("x", { id });
      clock.t += 1;
    }
    expect(await queue.tick()).toBe(2);
    expect((await rows()).map((r) => r.state)).toEqual(["done", "done", "pending"]);
    expect(await queue.tick()).toBe(1);
  });

  it("reclaims a running row whose lock expired, as after a process restart", async () => {
    const { db, queue, clock, rows } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", {});
    const [row] = await rows();
    expectOk(await db.updateOne<QueueRow>(QUEUE, row!.id, { state: "running", lockedAt: clock.t, lockedBy: "dead@host" }));
    expect(await queue.tick()).toBe(0);
    clock.t += 60_000;
    expect(await queue.tick()).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: "done" });
  });

  it("runs on a timer once started and stops cleanly", async () => {
    const { queue, rows } = await make({ pollMs: 2 });
    let calls = 0;
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => {
      calls++;
      return OK;
    });
    queue.startWorker();
    expect(queue.workerRunning()).toBe(true);
    await queue.enqueue("x", {});
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);
    await queue.stopWorker();
    expect(queue.workerRunning()).toBe(false);
    await queue.enqueue("x", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect((await rows()).map((r) => r.state)).toEqual(["done", "pending"]);
  });

  it("logs and continues when the fan-out query fails, still claiming due rows", async () => {
    const { db, queue } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", {});
    db.failNext("TRANSIENT");
    expect(await queue.tick()).toBe(1);
  });

  it("survives a persistence failure while claiming", async () => {
    const { db, queue } = await make();
    await queue.enqueue("x", {});
    db.failNext("TRANSIENT");
    expect(await queue.tick()).toBe(0);
  });

  it("fans out an unfanned row at the start of a tick, deleting the original", async () => {
    const { db, queue, rows } = await make();
    const created = expectOk(await db.createOne<QueueRow>(QUEUE, { name: "x", payload: { a: 1 }, pipeline: null, state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null }));
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async () => OK);
    expect(await queue.tick()).toBe(2);
    const stored = await rows();
    expect(stored.find((r) => r.id === created.id)).toBeUndefined();
    expect(stored.map((r) => r.pipeline).sort()).toEqual(["p1", "p2"]);
    expect(stored.every((r) => r.state === "done")).toBe(true);
  });

  it("drops an unfanned row nobody subscribes to", async () => {
    const { db, queue, rows } = await make();
    await db.createOne<QueueRow>(QUEUE, { name: "orphan", payload: {}, pipeline: null, state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    expect(await queue.tick()).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("claims no rows at all on a tick before setDelivery is ever called", async () => {
    const { db, queue, rows } = await make();
    await db.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "p1", state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null });
    expect(await queue.tick()).toBe(0);
    expect((await rows())[0]).toMatchObject({ state: "pending", attempts: 0 });
  });

  it("fans out an unfanned row exactly once when two instances both read it before either writes", async () => {
    const realDb = createFakePersistence();
    let findManyCalls = 0;
    const waiters: Array<() => void> = [];
    const db: typeof realDb = {
      ...realDb,
      findMany: boundaryCast<typeof realDb.findMany>(async (collection: string, filter: Record<string, unknown>, options?: Record<string, unknown>) => {
        const result = await realDb.findMany<QueueRow>(collection, filter, options);
        findManyCalls++;
        if (findManyCalls === 1) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        } else {
          for (const release of waiters.splice(0)) release();
        }
        return result;
      }, "host"),
    };
    const clock = { t: 1_000_000 };
    const queueA = await createEventsQueue(CONFIG, { db, logger: silentLogger, now: () => clock.t, instanceId: "a@host" });
    const queueB = await createEventsQueue(CONFIG, { db, logger: silentLogger, now: () => clock.t, instanceId: "b@host" });
    await realDb.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: null, state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null });
    queueA.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async () => OK);
    queueB.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async () => OK);

    await Promise.all([queueA.fanOutUnfanned(), queueB.fanOutUnfanned()]);

    const stored = expectOk(await realDb.findMany<QueueRow>(QUEUE, {}, { sort: { createdAt: "asc" } })).items;
    expect(stored.map((r) => r.pipeline).sort()).toEqual(["p1", "p2"]);
  });

  it("claims a row exactly once when two instances both read it as due before either updates it", async () => {
    const realDb = createFakePersistence();
    let findManyCalls = 0;
    const waiters: Array<() => void> = [];
    function isClaimQuery(filter: Record<string, unknown>): boolean {
      const pipeline = filter.pipeline;
      return !!pipeline && typeof pipeline === "object" && "ne" in pipeline;
    }
    const db: typeof realDb = {
      ...realDb,
      findMany: boundaryCast<typeof realDb.findMany>(async (collection: string, filter: Record<string, unknown>, options?: Record<string, unknown>) => {
        const result = await realDb.findMany<QueueRow>(collection, filter, options);
        if (!isClaimQuery(filter)) return result;
        findManyCalls++;
        if (findManyCalls === 1) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        } else {
          for (const release of waiters.splice(0)) release();
        }
        return result;
      }, "host"),
    };
    const clock = { t: 1_000_000 };
    const runsByInstance: Record<string, number> = { a: 0, b: 0 };
    const queueA = await createEventsQueue(CONFIG, { db, logger: silentLogger, now: () => clock.t, instanceId: "a@host" });
    const queueB = await createEventsQueue(CONFIG, { db, logger: silentLogger, now: () => clock.t, instanceId: "b@host" });
    await realDb.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "p1", state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null });
    queueA.setDelivery([{ event: "x", pipeline: "p1" }], async () => {
      runsByInstance.a = (runsByInstance.a ?? 0) + 1;
      return OK;
    });
    queueB.setDelivery([{ event: "x", pipeline: "p1" }], async () => {
      runsByInstance.b = (runsByInstance.b ?? 0) + 1;
      return OK;
    });

    const [handledA, handledB] = await Promise.all([queueA.tick(), queueB.tick()]);
    expect(handledA + handledB).toBe(1);
    expect((runsByInstance.a ?? 0) + (runsByInstance.b ?? 0)).toBe(1);
  });

  it("leaves the original row when a fan-out copy fails to write, instead of deleting it", async () => {
    const { db, queue, rows } = await make();
    const created = expectOk(await db.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: null, state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null }));
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async () => OK);

    const originalCreateOne = db.createOne.bind(db);
    let calls = 0;
    db.createOne = boundaryCast<typeof db.createOne>(async (collection: string, data: unknown) => {
      calls++;
      if (calls === 2) return err(failure("TRANSIENT", "boom"));
      return originalCreateOne(collection, boundaryCast<Parameters<typeof originalCreateOne>[1]>(data, "host"));
    }, "host");

    expect(await queue.fanOutUnfanned()).toBe(0);
    const stored = await rows();
    expect(stored.find((r) => r.id === created.id)).toMatchObject({ pipeline: null });
  });
});

describe("events/queue admin", () => {
  it("reports counts, the oldest pending event and the worker state", async () => {
    const { queue, clock } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async (_pipeline, input) => (input.payload?.boom === true ? { runId: "r", status: 500, error: "boom", code: "INTERNAL", retryable: false } : OK));
    await queue.enqueue("x", { boom: true });
    await queue.enqueue("x", {});
    clock.t += 5;
    await queue.enqueue("x", { later: true });
    expect(expectOk(await queue.status())).toEqual({ pending: 3, running: 0, dead: 0, done24h: 0, oldestPendingAt: 1_000_000, worker: { running: false, lastTickAt: null } });
    await queue.tick();
    await queue.tick();
    expect(expectOk(await queue.status())).toMatchObject({ pending: 1, done24h: 2, oldestPendingAt: 1_010_005, worker: { lastTickAt: 1_000_005 } });
  });

  it("retries one or every dead event and purges done rows past retention", async () => {
    const { queue, clock, rows } = await make({ maxAttempts: 1 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "y", pipeline: "p1" }], async (pipeline, input) => (input.trigger.name === "y" ? OK : { runId: "r", status: 500, error: "no", code: "INTERNAL", retryable: false }));
    await queue.enqueue("x", { id: "a" });
    await queue.enqueue("x", { id: "b" });
    await queue.enqueue("y", {});
    await queue.tick();
    await queue.tick();
    expect((await rows()).map((r) => r.state)).toEqual(["dead", "dead", "done"]);
    const [a] = await rows();
    expect(expectOk(await queue.retryDead(a!.id))).toEqual({ retried: 1 });
    expect(expectOk(await queue.retryDead(a!.id))).toEqual({ retried: 0 });
    expect(expectOk(await queue.retryDead("missing"))).toEqual({ retried: 0 });
    expect((await rows())[0]).toMatchObject({ state: "pending", attempts: 0, error: null, availableAt: clock.t });
    expect(expectOk(await queue.retryDead("all"))).toEqual({ retried: 1 });
    expect((await rows()).map((r) => r.state)).toEqual(["pending", "pending", "done"]);
    expect(expectOk(await queue.purgeDone())).toEqual({ removed: 0 });
    clock.t += 2 * 24 * 3600 * 1000;
    expect(expectOk(await queue.purgeDone())).toEqual({ removed: 1 });
    expect((await rows()).map((r) => r.state)).toEqual(["pending", "pending"]);
  });

  it("retryTarget accepts all and one only", () => {
    expect(retryTarget("all")).toBe("all");
    expect(retryTarget("one")).toBe("one");
    expect(() => retryTarget("x")).toThrow('"all" or "one"');
  });
});
