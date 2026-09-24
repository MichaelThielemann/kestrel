import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err } from "@michaelthielemann/kestrel/result";
import type { RunResult, Runner } from "@michaelthielemann/kestrel/runner";
import { createEventsQueue, DISCOVERY_INTERVAL_MS, QUEUE, QueueWriteError, retryTarget, type Config, type QueueRow } from "./impl.ts";

const CONFIG: Config = { pollMs: 5, batch: 2, maxAttempts: 3, backoffSeconds: [10, 100], lockTtlSeconds: 60, retentionDays: 1, relayMs: 5000, relayPipelines: "all", lanes: {} };

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
    await db.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "p1", state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null, coalesceKey: null, lane: "main" });
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
    await realDb.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "p1", state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null, coalesceKey: null, lane: "main" });
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
    expect(expectOk(await queue.status())).toEqual({ pending: 3, running: 0, dead: 0, done24h: 0, oldestPendingAt: 1_000_000, worker: { running: false, lastTickAt: null }, lanes: {} });
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

  it("a row waiting for its retry is not dead; at maxAttempts it is", async () => {
    const { queue, clock } = await make({ maxAttempts: 2 });
    const run: Runner = async () => ({ runId: "r", status: 500, error: "boom", code: "INTERNAL", retryable: false });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], run);
    await queue.enqueue("x", {});

    await queue.tick();
    expect(expectOk(await queue.deliveryStatus())).toEqual({ dead: 0, scope: "store", since: null, lastDeadAt: null });

    clock.t += 200_000;
    await queue.tick();
    expect(expectOk(await queue.deliveryStatus())).toEqual({ dead: 1, scope: "store", since: null, lastDeadAt: clock.t });
  });

  it("retrying a dead row lowers the dead count", async () => {
    const { queue, rows } = await make({ maxAttempts: 1 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => ({ runId: "r", status: 500, error: "no", code: "INTERNAL", retryable: false }));
    await queue.enqueue("x", {});
    await queue.tick();
    expect(expectOk(await queue.deliveryStatus())).toMatchObject({ dead: 1 });

    const [row] = await rows();
    expect(expectOk(await queue.retryDead(row!.id))).toEqual({ retried: 1 });
    expect(expectOk(await queue.deliveryStatus())).toMatchObject({ dead: 0 });
  });

  it("retryTarget accepts all and one only", () => {
    expect(retryTarget("all")).toBe("all");
    expect(retryTarget("one")).toBe("one");
    expect(() => retryTarget("x")).toThrow('"all" or "one"');
  });
});

describe("events/queue relay: head start", () => {
  it("a row belonging to a run is not claimable by a tick before createdAt + relayMs, but the run's own relay claims it at once", async () => {
    const { queue, clock, rows } = await make({ relayMs: 1000 });
    let calls = 0;
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => {
      calls++;
      return OK;
    });
    await queue.enqueue("x", { runId: "run-1" });
    expect((await rows())[0]).toMatchObject({ availableAt: clock.t + 1000, runId: "run-1" });

    await queue.tick();
    expect(calls).toBe(0);
    expect((await rows())[0]?.state).toBe("pending");

    const report = await queue.relay("run-1");
    expect(calls).toBe(1);
    expect(report).toEqual({ status: "done", pipelines: [{ event: "x", pipeline: "p1", status: "done", attempts: 0, dead: false, error: null }] });
    expect((await rows())[0]?.state).toBe("done");
  });

  it("a row raised through events@1 (no runId) is immediately available to a tick", async () => {
    const { queue, rows, clock } = await make({ relayMs: 1000 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", {});
    expect((await rows())[0]).toMatchObject({ availableAt: clock.t, runId: null });
    expect(await queue.tick()).toBe(1);
    expect((await rows())[0]?.state).toBe("done");
  });
});

describe("events/queue relay: no double delivery with the worker", () => {
  it("a row a tick already claimed is skipped by the relay, which reports it pending", async () => {
    const { queue, db, rows } = await make({ relayMs: 1000 });
    let calls = 0;
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => {
      calls++;
      return OK;
    });
    await queue.enqueue("x", { runId: "run-1" });
    const [row] = await rows();
    const won = await db.updateMany(QUEUE, { id: row!.id, state: "pending" }, { state: "running", lockedAt: 1, lockedBy: "another-worker" });
    expect(expectOk(won)).toBe(1);

    const report = await queue.relay("run-1");
    expect(calls).toBe(0);
    expect(report).toEqual({ status: "pending", pipelines: [{ event: "x", pipeline: "p1", status: "pending", attempts: 0, dead: false, error: null }] });
  });
});

describe("events/queue relay: the budget", () => {
  it("relayMs bounds how many rows the relay delivers; the rest is reported pending and left for the worker", async () => {
    const { queue, clock, rows } = await make({ relayMs: 5 });
    const order: string[] = [];
    queue.setDelivery([{ event: "x", pipeline: "slow" }, { event: "x", pipeline: "fast" }], async (pipeline) => {
      order.push(pipeline);
      if (pipeline === "slow") clock.t += 10;
      return OK;
    });
    await queue.enqueue("x", { runId: "run-1" });
    const report = await queue.relay("run-1");
    expect(order).toEqual(["slow"]);
    expect(report.status).toBe("pending");
    expect(report.pipelines).toContainEqual({ event: "x", pipeline: "slow", status: "done", attempts: 0, dead: false, error: null });
    expect(report.pipelines).toContainEqual({ event: "x", pipeline: "fast", status: "pending", attempts: 0, dead: false, error: null });
    expect((await rows()).find((r) => r.pipeline === "fast")?.state).toBe("pending");

    expect(await queue.tick()).toBe(1);
    expect((await rows()).every((r) => r.state === "done")).toBe(true);
  });

  it("relayMs: 0 disables the relay: nothing is claimed and everything stays for the worker", async () => {
    const { queue, rows } = await make({ relayMs: 0 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1" });
    const report = await queue.relay("run-1");
    expect(report).toEqual({ status: "pending", pipelines: [{ event: "x", pipeline: "p1", status: "pending", attempts: 0, dead: false, error: null }] });
    expect((await rows())[0]?.state).toBe("pending");
    expect(await queue.tick()).toBe(1);
    expect((await rows())[0]?.state).toBe("done");
  });
});

describe("events/queue relay: the map does not leak", () => {
  it("a run whose relay never came is swept off the map after lockTtlSeconds, on the next tick", async () => {
    const { queue, clock, rows } = await make({ relayMs: 1000, lockTtlSeconds: 30 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1" });

    clock.t += 30_000 + 1;
    await queue.tick();
    expect(await queue.relay("run-1")).toEqual({ status: "done", pipelines: [] });
    expect((await rows())[0]?.state).toBe("done");
  });

  it("a run whose relay came leaves nothing behind to sweep", async () => {
    const { queue } = await make({ relayMs: 1000 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1" });
    await queue.relay("run-1");
    expect(await queue.relay("run-1")).toEqual({ status: "done", pipelines: [] });
  });
});

describe("events/queue relay: zero cost for a run that enqueued nothing", () => {
  it("issues no persistence call when the run's map entry does not exist", async () => {
    const db = createFakePersistence();
    const calls: string[] = [];
    const spied = new Proxy<typeof db>(db, {
      get(target, prop, receiver): unknown {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && typeof value === "function") calls.push(prop);
        return value;
      },
    });
    const queue = await createEventsQueue(CONFIG, { db: spied, logger: silentLogger, instanceId: "test@host" });
    calls.length = 0;
    expect(await queue.relay("nothing-enqueued")).toEqual({ status: "done", pipelines: [] });
    expect(calls).toEqual([]);
  });
});

describe("events/queue relay: the store is unreachable", () => {
  it("reports pending and never throws or rejects when findMany fails", async () => {
    const { queue, db } = await make({ relayMs: 1000 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1" });
    db.failNext("TRANSIENT");
    await expect(queue.relay("run-1")).resolves.toEqual({ status: "pending", pipelines: [{ event: "", pipeline: "", status: "pending", attempts: 0, dead: false, error: null }] });
  });

  it("reports pending and never rejects when the persistence adapter itself throws", async () => {
    const realDb = createFakePersistence();
    const db: typeof realDb = {
      ...realDb,
      findMany: boundaryCast<typeof realDb.findMany>(async () => {
        throw new Error("adapter exploded");
      }, "host"),
    };
    const clock = { t: 1_000_000 };
    const queue = await createEventsQueue({ ...CONFIG, relayMs: 1000 }, { db, logger: silentLogger, now: () => clock.t, instanceId: "test@host" });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1" });
    await expect(queue.relay("run-1")).resolves.toEqual({ status: "pending", pipelines: [{ event: "", pipeline: "", status: "pending", attempts: 0, dead: false, error: null }] });
  });
});

describe("events/queue relay: a relay that never runs (process death after commit)", () => {
  it("a second instance's worker delivers the row once relayMs has passed, never before", async () => {
    const db = createFakePersistence();
    const clock = { t: 1_000_000 };
    const queueA = await createEventsQueue({ ...CONFIG, relayMs: 1000 }, { db, logger: silentLogger, now: () => clock.t, instanceId: "a@host" });
    const queueB = await createEventsQueue({ ...CONFIG, relayMs: 1000 }, { db, logger: silentLogger, now: () => clock.t, instanceId: "b@host" });
    let delivered = 0;
    queueA.setDelivery([{ event: "x", pipeline: "p1" }], async () => {
      delivered++;
      return OK;
    });
    queueB.setDelivery([{ event: "x", pipeline: "p1" }], async () => {
      delivered++;
      return OK;
    });

    await queueA.enqueue("x", { runId: "run-a" });

    expect(await queueB.tick()).toBe(0);
    expect(delivered).toBe(0);

    clock.t += 1000;
    expect(await queueB.tick()).toBe(1);
    expect(delivered).toBe(1);
  });
});

describe("events/queue relay: relayPipelines narrows the head start", () => {
  it("gives a head start only to a row whose pipeline is named; the other is available at once", async () => {
    const { queue, rows, clock } = await make({ relayMs: 1000, relayPipelines: ["p1"] });
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1" });
    const stored = await rows();
    expect(stored.find((r) => r.pipeline === "p1")).toMatchObject({ availableAt: clock.t + 1000 });
    expect(stored.find((r) => r.pipeline === "p2")).toMatchObject({ availableAt: clock.t });
  });

  it("relays the named pipeline and reports the other queued, without claiming it", async () => {
    const { queue, rows } = await make({ relayMs: 1000, relayPipelines: ["p1"] });
    const order: string[] = [];
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async (pipeline) => {
      order.push(pipeline);
      return OK;
    });
    await queue.enqueue("x", { runId: "run-1" });

    const report = await queue.relay("run-1");
    expect(order).toEqual(["p1"]);
    expect(report.status).toBe("pending");
    expect(report.pipelines).toContainEqual({ event: "x", pipeline: "p1", status: "done", attempts: 0, dead: false, error: null });
    expect(report.pipelines).toContainEqual({ event: "x", pipeline: "p2", status: "queued", attempts: 0, dead: false, error: null });
    expect((await rows()).find((r) => r.pipeline === "p2")).toMatchObject({ state: "pending" });

    expect(await queue.tick()).toBe(1);
    expect(order).toEqual(["p1", "p2"]);
    expect((await rows()).every((r) => r.state === "done")).toBe(true);
  });

  it("an empty relayPipelines list relays nothing and reports every row queued", async () => {
    const { queue, rows } = await make({ relayMs: 1000, relayPipelines: [] });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1" });
    const report = await queue.relay("run-1");
    expect(report).toEqual({ status: "pending", pipelines: [{ event: "x", pipeline: "p1", status: "queued", attempts: 0, dead: false, error: null }] });
    expect((await rows())[0]).toMatchObject({ state: "pending" });
  });

  it("the default \"all\" still relays every subscribed pipeline", async () => {
    const { queue, rows } = await make({ relayMs: 1000 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1" });
    const report = await queue.relay("run-1");
    expect(report.status).toBe("done");
    expect(report.pipelines.map((p) => p.pipeline).sort()).toEqual(["p1", "p2"]);
    expect((await rows()).every((r) => r.state === "done")).toBe(true);
  });
});

describe("events/queue relay: a run with two emits relays both", () => {
  it("does not let a second emit's enqueue replace the first's map entry", async () => {
    const { queue, rows } = await make({ relayMs: 1000 });
    let calls = 0;
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "y", pipeline: "p2" }], async () => {
      calls++;
      return OK;
    });
    await queue.enqueue("x", { runId: "run-1" });
    await queue.enqueue("y", { runId: "run-1" });
    expect(await rows()).toHaveLength(2);

    const report = await queue.relay("run-1");
    expect(calls).toBe(2);
    expect(report.status).toBe("done");
    expect(report.pipelines).toContainEqual({ event: "x", pipeline: "p1", status: "done", attempts: 0, dead: false, error: null });
    expect(report.pipelines).toContainEqual({ event: "y", pipeline: "p2", status: "done", attempts: 0, dead: false, error: null });
    expect((await rows()).every((r) => r.state === "done")).toBe(true);
  });
});

describe("events/queue coalescing", () => {
  it("a duplicate coalesceKey while the earlier row is pending writes only one row", async () => {
    const { queue, rows } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ coalesceKey: "p1:doc-1", state: "pending" });
  });

  it("coalescing is per pipeline: the same key for two subscribed pipelines writes one row each", async () => {
    const { queue, rows } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }, { event: "x", pipeline: "p2" }], async () => OK);
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    const stored = await rows();
    expect(stored.map((r) => r.pipeline).sort()).toEqual(["p1", "p2"]);
  });

  it("an event without a coalesceKey is never coalesced", async () => {
    const { queue, rows } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", {});
    await queue.enqueue("x", {});
    expect(await rows()).toHaveLength(2);
  });

  it("a unique conflict on another column still fails", async () => {
    const { db, queue } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    const originalCreateOne = db.createOne.bind(db);
    let calls = 0;
    db.createOne = boundaryCast<typeof db.createOne>(async (collection: string, data: unknown) => {
      calls++;
      if (calls === 1) return err(failure("CONFLICT", "boom", { details: { collection, field: "id" } }));
      return originalCreateOne(collection, boundaryCast<Parameters<typeof originalCreateOne>[1]>(data, "host"));
    }, "host");
    await expect(queue.enqueue("x", { coalesceKey: "doc-1" })).rejects.toBeInstanceOf(QueueWriteError);
  });

  it("claim clears coalesceKey, so a finished job's key no longer blocks a new one", async () => {
    const { queue, rows } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    expect(await queue.tick()).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: "done", coalesceKey: null });
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    expect(await rows()).toHaveLength(2);
  });

  it("a mark while the job runs enqueues one more row, deterministically at the claim", async () => {
    const { db, queue, rows } = await make();
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let claimSeen: (() => void) | undefined;
    const claimSeenPromise = new Promise<void>((resolve) => {
      claimSeen = resolve;
    });
    const originalUpdateMany = db.updateMany.bind(db);
    let sawClaim = false;
    db.updateMany = boundaryCast<typeof db.updateMany>(async (collection: string, filter: Record<string, unknown>, patch: Record<string, unknown>) => {
      const result = await originalUpdateMany(collection, boundaryCast<Parameters<typeof originalUpdateMany>[1]>(filter, "host"), boundaryCast<Parameters<typeof originalUpdateMany>[2]>(patch, "host"));
      if (!sawClaim && patch.state === "running") {
        sawClaim = true;
        claimSeen?.();
      }
      return result;
    }, "host");
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => {
      await runGate;
      return OK;
    });
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    const tickPromise = queue.tick();
    await claimSeenPromise;
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    expect(await rows()).toHaveLength(2);
    releaseRun?.();
    await tickPromise;
  });

  it("the relay's claim also clears coalesceKey", async () => {
    const { queue, rows } = await make({ relayMs: 1000 });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { runId: "run-1", coalesceKey: "doc-1" });
    await queue.relay("run-1");
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    expect(await rows()).toHaveLength(2);
  });

  it("the fan-out carries the coalesceKey: two unfanned events with the same key collapse to one row per pipeline", async () => {
    const { queue, rows } = await make();
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    expect(await rows()).toHaveLength(2);
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    expect(await queue.tick()).toBe(1);
    const stored = await rows();
    expect(stored.filter((r) => r.pipeline === "p1")).toHaveLength(1);
  });

  it("a stale coalesceKey left on a non-pending row is cleared so a later enqueue is not silently swallowed", async () => {
    const { db, queue, rows } = await make();
    await db.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "p1", state: "done", attempts: 0, createdAt: 1, availableAt: 1, lockedAt: null, lockedBy: null, finishedAt: 1, error: null, runId: null, coalesceKey: "p1:doc-1", lane: "main" });
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await queue.enqueue("x", { coalesceKey: "doc-1" });
    const stored = await rows();
    expect(stored.filter((r) => r.state === "pending" && r.coalesceKey === "p1:doc-1")).toHaveLength(1);
  });
});

describe("events/queue lanes: a mark during a lane job", () => {
  it("a mark while a lane job runs enqueues one more row", async () => {
    const { queue, rows } = await make({ lanes: { pages: ["render"] } });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started: (() => void) | undefined;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      started?.();
      await gate;
      return OK;
    });
    await queue.enqueue("x", { coalesceKey: "k" });
    const t = queue.tickLane("pages");
    await startedP;
    expect((await rows()).find((r) => r.state === "running")).toMatchObject({ coalesceKey: null });
    await queue.enqueue("x", { coalesceKey: "k" });
    expect(await rows()).toHaveLength(2);
    release?.();
    await t;
  });

  it("a failed lane row waits out its backoff before retrying; a new mark is written beside it", async () => {
    const { queue, clock, rows } = await make({ backoffSeconds: [100], lanes: { pages: ["render"] } });
    let runs = 0;
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      runs++;
      return { runId: "r", status: 500, error: "boom", code: "INTERNAL", retryable: false };
    });
    await queue.enqueue("x", { coalesceKey: "k" });
    expect(await queue.tickLane("pages")).toBe(1);
    await queue.enqueue("x", { coalesceKey: "k" });
    expect((await rows()).map((r) => [r.state, r.attempts, r.coalesceKey])).toEqual([
      ["pending", 1, null],
      ["pending", 0, "render:k"],
    ]);
    expect(await queue.tickLane("pages")).toBe(1);
    expect(await queue.tickLane("pages")).toBe(0);
    clock.t += 100_000;
    expect(await queue.tickLane("pages")).toBe(1);
    expect(runs).toBe(3);
  });
});

describe("events/queue lanes: set at enqueue and fan-out", () => {
  it("a lane pipeline's row carries its lane; an unlisted pipeline's row carries \"main\"", async () => {
    const { queue, rows } = await make({ lanes: { pages: ["render"] } });
    queue.setDelivery([{ event: "x", pipeline: "render" }, { event: "y", pipeline: "other" }], async () => OK);
    await queue.enqueue("x", {});
    await queue.enqueue("y", {});
    const stored = await rows();
    expect(stored.find((r) => r.pipeline === "render")).toMatchObject({ lane: "pages" });
    expect(stored.find((r) => r.pipeline === "other")).toMatchObject({ lane: "main" });
  });

  it("a row fanned out from an unfanned row carries the lane of its pipeline", async () => {
    const { queue, rows } = await make({ lanes: { pages: ["render"] } });
    await queue.enqueue("x", {});
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => OK);
    expect(await queue.fanOutUnfanned()).toBe(1);
    expect((await rows())[0]).toMatchObject({ pipeline: "render", lane: "pages" });
  });

  it("gives an existing row with no lane \"main\" at setup", async () => {
    const db = createFakePersistence();
    await db.ensureCollection(QUEUE, { name: "string", payload: "json", pipeline: "string", state: "string", attempts: "number", createdAt: "number", availableAt: "number", lockedAt: "number", lockedBy: "string", finishedAt: "number", error: "string", runId: "string" });
    await db.createOne(QUEUE, { id: "pre-lanes", name: "x", payload: {}, pipeline: "p1", state: "pending", attempts: 0, createdAt: 1, availableAt: 1, lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId: null });
    await createEventsQueue(CONFIG, { db, logger: silentLogger, instanceId: "test@host" });
    const row = expectOk(await db.findOne<QueueRow>(QUEUE, { id: "pre-lanes" }));
    expect(row).toMatchObject({ lane: "main" });
  });

  it("a row written without a lane after setup is adopted into main by the periodic sweep", async () => {
    const { db, queue, rows } = await make();
    queue.setDelivery([{ event: "x", pipeline: "p1" }], async () => OK);
    await db.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "p1", state: "pending", attempts: 0, createdAt: 1, availableAt: 1, lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId: null });
    expect(await queue.tick()).toBe(0);
    expect((await rows())[0]).toMatchObject({ lane: "main" });
    expect(await queue.tick()).toBe(1);
  });
});

describe("events/queue lanes: status per lane", () => {
  it("readQueueStatus reports pending/running/oldestPendingAt per configured lane; totals still count every lane", async () => {
    const { queue } = await make({ lanes: { pages: ["render"], variants: ["generate"] } });
    queue.setDelivery([{ event: "x", pipeline: "render" }, { event: "y", pipeline: "generate" }, { event: "z", pipeline: "other" }], async () => OK);
    await queue.enqueue("x", { id: "1" });
    await queue.enqueue("x", { id: "2" });
    await queue.enqueue("z", {});
    const status = expectOk(await queue.status());
    expect(status.lanes).toEqual({ pages: { pending: 2, running: 0, oldestPendingAt: 1_000_000 }, variants: { pending: 0, running: 0, oldestPendingAt: null } });
    expect(status.pending).toBe(3);
  });

  it("a running lane row is counted in its own lane only", async () => {
    const { queue } = await make({ lanes: { pages: ["render"], variants: ["generate"] } });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      await gate;
      return OK;
    });
    await queue.enqueue("x", {});
    const t = queue.tickLane("pages");
    await new Promise((r) => setTimeout(r, 0));
    const status = expectOk(await queue.status());
    release?.();
    await t;
    expect(status.lanes).toEqual({ pages: { pending: 0, running: 1, oldestPendingAt: null }, variants: { pending: 0, running: 0, oldestPendingAt: null } });
  });
});

describe("events/queue lanes: no lane delays another", () => {
  it("N blocked jobs in one lane never delay a job in the main lane or in another lane", async () => {
    const { queue, rows } = await make({ lanes: { pages: ["render"], variants: ["generate"] } });
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    let renderCalls = 0;
    queue.setDelivery(
      [{ event: "render.due", pipeline: "render" }, { event: "plan.due", pipeline: "plan" }, { event: "generate.due", pipeline: "generate" }],
      async (pipeline) => {
        started.push(pipeline);
        if (pipeline === "render") {
          renderCalls++;
          if (renderCalls === 1) await gate;
        }
        return OK;
      },
    );

    for (let i = 0; i < 50; i++) await queue.enqueue("render.due", { id: String(i) });
    const pagesTick = queue.tickLane("pages");
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["render"]);

    await queue.enqueue("plan.due", {});
    await queue.enqueue("generate.due", {});

    expect(await queue.tick()).toBe(1);
    expect(await queue.tickLane("variants")).toBe(1);

    expect(started).toEqual(["render", "plan", "generate"]);
    const stored = await rows();
    expect(stored.filter((r) => r.pipeline === "render" && r.state === "pending")).toHaveLength(49);

    releaseFirst?.();
    await pagesTick;
  });

  it("control: without lanes, everything shares one loop and blocks behind the render in progress", async () => {
    const { queue } = await make({ lanes: {}, batch: 1 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    queue.setDelivery(
      [{ event: "render.due", pipeline: "render" }, { event: "plan.due", pipeline: "plan" }, { event: "generate.due", pipeline: "generate" }],
      async (pipeline) => {
        started.push(pipeline);
        if (pipeline === "render") await gate;
        return OK;
      },
    );
    await queue.enqueue("render.due", { id: "0" });
    await queue.enqueue("plan.due", {});
    await queue.enqueue("generate.due", {});
    const tickPromise = queue.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["render"]);
    release?.();
    await tickPromise;
  });

  it("control: one shared lane makes generate wait for every render queued before it", async () => {
    const { queue } = await make({ lanes: { pages: ["render", "generate"] } });
    const order: string[] = [];
    queue.setDelivery([{ event: "render.due", pipeline: "render" }, { event: "generate.due", pipeline: "generate" }], async (pipeline) => {
      order.push(pipeline);
      return OK;
    });
    for (let i = 0; i < 50; i++) await queue.enqueue("render.due", { id: String(i) });
    await queue.enqueue("generate.due", {});
    for (let i = 0; i < 50; i++) {
      expect(await queue.tickLane("pages")).toBe(1);
      expect(order).not.toContain("generate");
    }
    expect(await queue.tickLane("pages")).toBe(1);
    expect(order[order.length - 1]).toBe("generate");
  });
});

describe("events/queue lanes: crash recovery per lane", () => {
  it("a lane row whose lock expired is reclaimed by the main tick's global sweep, then rerun by its own lane", async () => {
    const { db, queue, clock, rows } = await make({ lanes: { pages: ["render"] } });
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => OK);
    await queue.enqueue("x", {});
    const [row] = await rows();
    expectOk(await db.updateOne<QueueRow>(QUEUE, row!.id, { state: "running", lockedAt: clock.t, lockedBy: "dead@host" }));

    expect(await queue.tickLane("pages")).toBe(0);
    clock.t += 60_000;
    expect(await queue.tick()).toBe(0);
    expect(await queue.tickLane("pages")).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: "done" });
  });

  it("a lane's own claim reclaims its expired locks without waiting for the main loop", async () => {
    const { db, queue, clock, rows } = await make({ lanes: { pages: ["render"] } });
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => OK);
    await queue.enqueue("x", {});
    const [row] = await rows();
    expectOk(await db.updateOne<QueueRow>(QUEUE, row!.id, { state: "running", lockedAt: clock.t, lockedBy: "dead@host" }));

    clock.t += 60_000;
    expect(await queue.tickLane("pages")).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: "done" });
  });
});

describe("events/queue lanes: two processes claiming", () => {
  it("two processes' lane loops claim a row exactly once", async () => {
    const realDb = createFakePersistence();
    let findManyCalls = 0;
    const waiters: Array<() => void> = [];
    function isLaneClaimQuery(filter: Record<string, unknown>): boolean {
      return filter.lane === "pages";
    }
    const db: typeof realDb = {
      ...realDb,
      findMany: boundaryCast<typeof realDb.findMany>(async (collection: string, filter: Record<string, unknown>, options?: Record<string, unknown>) => {
        const result = await realDb.findMany<QueueRow>(collection, filter, options);
        if (!isLaneClaimQuery(filter)) return result;
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
    const queueA = await createEventsQueue({ ...CONFIG, lanes: { pages: ["render"] } }, { db, logger: silentLogger, now: () => clock.t, instanceId: "a@host" });
    const queueB = await createEventsQueue({ ...CONFIG, lanes: { pages: ["render"] } }, { db, logger: silentLogger, now: () => clock.t, instanceId: "b@host" });
    await realDb.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "render", state: "pending", attempts: 0, createdAt: 1_000_000, availableAt: 1_000_000, lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId: null, coalesceKey: null, lane: "pages" });
    queueA.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      runsByInstance.a = (runsByInstance.a ?? 0) + 1;
      return OK;
    });
    queueB.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      runsByInstance.b = (runsByInstance.b ?? 0) + 1;
      return OK;
    });

    const [handledA, handledB] = await Promise.all([queueA.tickLane("pages"), queueB.tickLane("pages")]);
    expect(handledA + handledB).toBe(1);
    expect((runsByInstance.a ?? 0) + (runsByInstance.b ?? 0)).toBe(1);
  });
});

describe("events/queue lanes: the relay never claims a lane row", () => {
  it("gives no head start and reports queued, whatever relayPipelines says", async () => {
    const { queue, rows } = await make({ relayMs: 1000, lanes: { pages: ["render"] } });
    let called = 0;
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      called++;
      return OK;
    });
    await queue.enqueue("x", { runId: "run-1" });
    expect((await rows())[0]).toMatchObject({ availableAt: 1_000_000, lane: "pages" });

    const report = await queue.relay("run-1");
    expect(called).toBe(0);
    expect(report).toEqual({ status: "pending", pipelines: [{ event: "x", pipeline: "render", status: "queued", attempts: 0, dead: false, error: null }] });

    expect(await queue.tickLane("pages")).toBe(1);
    expect(called).toBe(1);
  });

  it("still gives no head start even when relayPipelines explicitly names the lane pipeline", async () => {
    const { queue, rows } = await make({ relayMs: 1000, relayPipelines: ["render"], lanes: { pages: ["render"] } });
    let called = 0;
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      called++;
      return OK;
    });
    await queue.enqueue("x", { runId: "run-1" });
    expect((await rows())[0]).toMatchObject({ availableAt: 1_000_000 });
    const report = await queue.relay("run-1");
    expect(called).toBe(0);
    expect(report.status).toBe("pending");
  });
});

describe("events/queue lanes: a pipeline moved out of a lane between two boots", () => {
  it("keeps a loop, via startWorker, until its pending rows finish", async () => {
    const db = createFakePersistence();
    const queue1 = await createEventsQueue({ ...CONFIG, lanes: { pages: ["render"] } }, { db, logger: silentLogger, instanceId: "a@host" });
    queue1.setDelivery([{ event: "x", pipeline: "render" }], async () => OK);
    await queue1.enqueue("x", {});

    const queue2 = await createEventsQueue({ ...CONFIG, lanes: {}, pollMs: 2 }, { db, logger: silentLogger, instanceId: "b@host" });
    let calls = 0;
    queue2.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      calls++;
      return OK;
    });
    queue2.startWorker();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
    await queue2.stopWorker();
  });
});

describe("events/queue lanes: an orphan lane's rows are never stranded", () => {
  it("retrying a dead row in a lane the current config no longer names starts that lane's loop on the next main tick", async () => {
    const db = createFakePersistence();
    const queue = await createEventsQueue({ ...CONFIG, lanes: {}, pollMs: 5 }, { db, logger: silentLogger, instanceId: "a@host" });
    let runs = 0;
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      runs++;
      return OK;
    });
    await db.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "render", state: "dead", attempts: 3, createdAt: 1, availableAt: 1, lockedAt: null, lockedBy: null, finishedAt: 1, error: "boom", runId: null, coalesceKey: null, lane: "pages" });

    queue.startWorker();
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(0);

    expect(expectOk(await queue.retryDead("all"))).toEqual({ retried: 1 });
    await new Promise((r) => setTimeout(r, 40));
    expect(runs).toBe(1);
    await queue.stopWorker();
  });

  it("a discovery scan that fails is retried after the throttle window instead of stranding a lane's rows forever", async () => {
    const realDb = createFakePersistence();
    let discoveryCalls = 0;
    function isDiscoveryQuery(filter: Record<string, unknown>): boolean {
      return "state" in filter && !("lane" in filter) && !("pipeline" in filter);
    }
    const db: typeof realDb = {
      ...realDb,
      findMany: boundaryCast<typeof realDb.findMany>(async (collection: string, filter: Record<string, unknown>, options?: Record<string, unknown>) => {
        if (isDiscoveryQuery(filter)) {
          discoveryCalls++;
          if (discoveryCalls === 1) return err(failure("TRANSIENT", "boom"));
        }
        return realDb.findMany<QueueRow>(collection, filter, options);
      }, "host"),
    };
    const clock = { t: 1_000_000 };
    const queue = await createEventsQueue({ ...CONFIG, lanes: {}, pollMs: 5 }, { db, logger: silentLogger, now: () => clock.t, instanceId: "a@host" });
    await realDb.createOne<QueueRow>(QUEUE, { name: "x", payload: {}, pipeline: "render", state: "pending", attempts: 0, createdAt: 1, availableAt: 1, lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId: null, coalesceKey: null, lane: "pages" });
    let runs = 0;
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      runs++;
      return OK;
    });

    queue.startWorker();
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(0);
    expect(discoveryCalls).toBeGreaterThanOrEqual(1);

    clock.t += DISCOVERY_INTERVAL_MS;
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(1);
    expect(discoveryCalls).toBeGreaterThanOrEqual(2);
    await queue.stopWorker();
  });
});

describe("events/queue lanes: a lost claim retries at once", () => {
  it("a lost lane claim schedules its next attempt at once instead of waiting pollMs", async () => {
    const realDb = createFakePersistence();
    let findManyCalls = 0;
    const waiters: Array<() => void> = [];
    function isLaneClaimQuery(filter: Record<string, unknown>): boolean {
      return filter.lane === "pages";
    }
    const db: typeof realDb = {
      ...realDb,
      findMany: boundaryCast<typeof realDb.findMany>(async (collection: string, filter: Record<string, unknown>, options?: Record<string, unknown>) => {
        const result = await realDb.findMany<QueueRow>(collection, filter, options);
        if (!isLaneClaimQuery(filter) || findManyCalls >= 2) return result;
        findManyCalls++;
        if (findManyCalls === 1) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        } else {
          for (const release of waiters.splice(0)) release();
        }
        return result;
      }, "host"),
    };
    const queueA = await createEventsQueue({ ...CONFIG, pollMs: 3000, lanes: { pages: ["render"] } }, { db, logger: silentLogger, instanceId: "a@host" });
    const queueB = await createEventsQueue({ ...CONFIG, pollMs: 3000, lanes: { pages: ["render"] } }, { db, logger: silentLogger, instanceId: "b@host" });
    await realDb.createOne<QueueRow>(QUEUE, { name: "x", payload: { id: "1" }, pipeline: "render", state: "pending", attempts: 0, createdAt: 1, availableAt: 1, lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId: null, coalesceKey: null, lane: "pages" });
    await realDb.createOne<QueueRow>(QUEUE, { name: "x", payload: { id: "2" }, pipeline: "render", state: "pending", attempts: 0, createdAt: 2, availableAt: 2, lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId: null, coalesceKey: null, lane: "pages" });
    const order: string[] = [];
    let releaseWinnerOfFirstRow: (() => void) | undefined;
    const firstRowGate = new Promise<void>((r) => {
      releaseWinnerOfFirstRow = r;
    });
    const run = (label: string): Runner =>
      async (_pipeline, input) => {
        const id = String(input.payload?.id);
        order.push(`${label}:${id}`);
        if (id === "1") await firstRowGate;
        return OK;
      };
    queueA.setDelivery([{ event: "x", pipeline: "render" }], run("a"));
    queueB.setDelivery([{ event: "x", pipeline: "render" }], run("b"));

    queueA.startWorker();
    queueB.startWorker();
    await new Promise((r) => setTimeout(r, 50));
    expect(order.map((entry) => entry.split(":")[1]).sort()).toEqual(["1", "2"]);

    releaseWinnerOfFirstRow?.();
    await queueA.stopWorker();
    await queueB.stopWorker();
  });
});

describe("events/queue lanes: a claim error does not spin the loop", () => {
  it("a claim whose UPDATE fails does not spin the lane loop", async () => {
    const real = createFakePersistence();
    const originalUpdateMany = real.updateMany.bind(real);
    let claimAttempts = 0;
    const db: typeof real = {
      ...real,
      updateMany: boundaryCast<typeof real.updateMany>(async (collection: string, filter: Record<string, unknown>, patch: Record<string, unknown>) => {
        if (patch.state === "running") {
          claimAttempts++;
          return err(failure("INTERNAL", "database or disk is full"));
        }
        return originalUpdateMany(collection, boundaryCast<Parameters<typeof originalUpdateMany>[1]>(filter, "host"), boundaryCast<Parameters<typeof originalUpdateMany>[2]>(patch, "host"));
      }, "host"),
    };
    const queue = await createEventsQueue({ ...CONFIG, pollMs: 1000, lanes: { pages: ["render"] } }, { db, logger: silentLogger });
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => OK);
    await queue.enqueue("x", {});
    queue.startWorker();
    await new Promise((r) => setTimeout(r, 100));
    await queue.stopWorker();
    expect(claimAttempts).toBeLessThanOrEqual(2);
  });
});

describe("events/queue lanes: fake-timer pins for the shutdown ordering", () => {
  afterEach(() => vi.useRealTimers());

  it("stopWorker leaves no timer pending the moment it is called, while the main tick is still in flight", async () => {
    vi.useFakeTimers();
    const db = createFakePersistence();
    const queue = await createEventsQueue({ ...CONFIG, pollMs: 500, lanes: { pages: ["render"] } }, { db, logger: silentLogger });
    let releaseMain: (() => void) | undefined;
    const mainGate = new Promise<void>((r) => {
      releaseMain = r;
    });
    const laneStarts: string[] = [];
    queue.setDelivery([{ event: "m", pipeline: "main1" }, { event: "x", pipeline: "render" }], async (pipeline) => {
      if (pipeline === "main1") await mainGate;
      else laneStarts.push(pipeline);
      return OK;
    });
    await queue.enqueue("m", {});
    queue.startWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await queue.enqueue("x", {});
    const stopping = queue.stopWorker();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(laneStarts).toEqual([]);
    releaseMain?.();
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stop/start pair while a lane tick is in flight leaves exactly one timer chain per loop", async () => {
    vi.useFakeTimers();
    const db = createFakePersistence();
    const queue = await createEventsQueue({ ...CONFIG, pollMs: 500, lanes: { pages: ["render"] } }, { db, logger: silentLogger });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let runs = 0;
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      runs++;
      if (runs === 1) await gate;
      return OK;
    });
    await queue.enqueue("x", {});
    queue.startWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    void queue.stopWorker();
    queue.startWorker();
    await vi.advanceTimersByTimeAsync(0);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.getTimerCount()).toBe(2);
    await queue.stopWorker();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("events/queue lanes: stopWorker awaits every loop", () => {
  it("awaits the main loop and every lane loop before resolving", async () => {
    const { queue } = await make({ lanes: { pages: ["render"] }, pollMs: 2 });
    let releaseMain: (() => void) | undefined;
    let releaseLane: (() => void) | undefined;
    const mainGate = new Promise<void>((r) => {
      releaseMain = r;
    });
    const laneGate = new Promise<void>((r) => {
      releaseLane = r;
    });
    let mainDone = false;
    let laneDone = false;
    queue.setDelivery([{ event: "x", pipeline: "other" }, { event: "y", pipeline: "render" }], async (pipeline) => {
      if (pipeline === "other") {
        await mainGate;
        mainDone = true;
      } else {
        await laneGate;
        laneDone = true;
      }
      return OK;
    });
    await queue.enqueue("x", {});
    await queue.enqueue("y", {});
    queue.startWorker();
    await new Promise((r) => setTimeout(r, 20));
    const stopping = queue.stopWorker();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    releaseMain?.();
    releaseLane?.();
    await stopping;
    expect(mainDone).toBe(true);
    expect(laneDone).toBe(true);
  });

  it("stopWorker still waits for a lane job once the main loop has already settled", async () => {
    const { queue } = await make({ lanes: { pages: ["render"] } });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started: (() => void) | undefined;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    queue.setDelivery([{ event: "x", pipeline: "render" }], async () => {
      started?.();
      await gate;
      return OK;
    });
    await queue.enqueue("x", {});
    queue.startWorker();
    await startedP;
    let stopped = false;
    const stopping = queue.stopWorker().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});
