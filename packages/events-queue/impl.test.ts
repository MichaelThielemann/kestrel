import { describe, expect, it } from "vitest";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { createEventsQueue, QUEUE, QueueWriteError, retryTarget, type Config, type QueueRow } from "./impl.ts";

const CONFIG: Config = { pollMs: 5, batch: 2, maxAttempts: 3, backoffSeconds: [10, 100], lockTtlSeconds: 60, retentionDays: 1 };

async function make(overrides: Partial<Config> = {}) {
  const db = createFakePersistence();
  const clock = { t: 1_000_000 };
  const queue = await createEventsQueue({ ...CONFIG, ...overrides }, { db, logger: silentLogger, now: () => clock.t, instanceId: "test@host" });
  const rows = async () => expectOk(await db.findMany<QueueRow>(QUEUE, {}, { sort: { createdAt: "asc" } })).items;
  return { db, clock, queue, rows };
}

describe("events/queue emit", () => {
  it("persists a pending row and returns without running handlers", async () => {
    const { queue, rows } = await make();
    let calls = 0;
    queue.on("x", async () => {
      calls++;
    });
    await queue.emit("x", { id: "1" });
    expect(calls).toBe(0);
    expect(await rows()).toMatchObject([{ name: "x", payload: { id: "1" }, state: "pending", attempts: 0, availableAt: 1_000_000 }]);
  });

  it("rejects with QueueWriteError when the row cannot be written", async () => {
    const { db, queue } = await make();
    db.failNext("TRANSIENT");
    await expect(queue.emit("x", {})).rejects.toBeInstanceOf(QueueWriteError);
  });
});

describe("events/queue worker", () => {
  it("delivers a frozen copy to every handler in order and marks the row done", async () => {
    const { queue, rows } = await make();
    const order: string[] = [];
    const seen: unknown[] = [];
    queue.on("x", async (_n, data) => {
      order.push("a");
      seen.push(data);
    });
    queue.on("x", async (_n, data) => {
      order.push("b");
      seen.push(data);
    });
    await queue.emit("x", { id: "1" });
    expect(await queue.tick()).toBe(1);
    expect(order).toEqual(["a", "b"]);
    expect(seen[0]).toBe(seen[1]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(await rows()).toMatchObject([{ state: "done", attempts: 0, finishedAt: 1_000_000, lockedAt: null, lockedBy: null }]);
  });

  it("marks a row without handlers done", async () => {
    const { queue, rows } = await make();
    await queue.emit("nobody", {});
    await queue.tick();
    expect((await rows())[0]?.state).toBe("done");
  });

  it("retries with backoff and ends done after a handler that fails twice", async () => {
    const { queue, clock, rows } = await make();
    let calls = 0;
    queue.on("x", async () => {
      calls++;
      if (calls <= 2) throw new Error(`fail ${calls}`);
    });
    await queue.emit("x", {});
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
    queue.on("x", async () => {
      throw new Error("always");
    });
    await queue.emit("x", {});
    for (let i = 0; i < 3; i++) {
      clock.t += 200_000;
      await queue.tick();
    }
    expect(await rows()).toMatchObject([{ state: "dead", attempts: 3, error: "always" }]);
    expect(expectOk(await queue.listDead(10)).items).toMatchObject([{ name: "x", attempts: 3, error: "always" }]);
  });

  it("aggregates the errors of several failing handlers", async () => {
    const { queue, rows } = await make();
    queue.on("x", async () => {
      throw new Error("first");
    });
    queue.on("x", async () => {
      throw new Error("second");
    });
    await queue.emit("x", {});
    await queue.tick();
    expect((await rows())[0]?.error).toBe("first; second");
  });

  it("claims at most batch rows per tick, oldest first", async () => {
    const { queue, clock, rows } = await make();
    for (const id of ["1", "2", "3"]) {
      await queue.emit("x", { id });
      clock.t += 1;
    }
    expect(await queue.tick()).toBe(2);
    expect((await rows()).map((r) => r.state)).toEqual(["done", "done", "pending"]);
    expect(await queue.tick()).toBe(1);
  });

  it("reclaims a running row whose lock expired, as after a process restart", async () => {
    const { db, queue, clock, rows } = await make();
    await queue.emit("x", {});
    const [row] = await rows();
    expectOk(await db.updateOne<QueueRow>(QUEUE, row!.id, { state: "running", lockedAt: clock.t, lockedBy: "dead@host" }));
    let calls = 0;
    queue.on("x", async () => {
      calls++;
    });
    expect(await queue.tick()).toBe(0);
    clock.t += 60_000;
    expect(await queue.tick()).toBe(1);
    expect(calls).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: "done" });
  });

  it("runs on a timer once started and stops cleanly", async () => {
    const { queue, rows } = await make({ pollMs: 2 });
    let calls = 0;
    queue.on("x", async () => {
      calls++;
    });
    queue.startWorker();
    expect(queue.workerRunning()).toBe(true);
    await queue.emit("x", {});
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);
    await queue.stopWorker();
    expect(queue.workerRunning()).toBe(false);
    await queue.emit("x", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect((await rows()).map((r) => r.state)).toEqual(["done", "pending"]);
  });

  it("survives a persistence failure during a tick", async () => {
    const { db, queue } = await make();
    await queue.emit("x", {});
    db.failNext("TRANSIENT");
    expect(await queue.tick()).toBe(0);
    expect(await queue.tick()).toBe(1);
  });
});

describe("events/queue admin", () => {
  it("reports counts, the oldest pending event and the worker state", async () => {
    const { queue, clock } = await make();
    queue.on("x", async (_n, data) => {
      if (data.boom === true) throw new Error("boom");
    });
    await queue.emit("x", { boom: true });
    await queue.emit("x", {});
    clock.t += 5;
    await queue.emit("x", { later: true });
    expect(expectOk(await queue.status())).toEqual({ pending: 3, running: 0, dead: 0, done24h: 0, oldestPendingAt: 1_000_000, worker: { running: false, lastTickAt: null } });
    await queue.tick();
    await queue.tick();
    expect(expectOk(await queue.status())).toMatchObject({ pending: 1, done24h: 2, oldestPendingAt: 1_010_005, worker: { lastTickAt: 1_000_005 } });
  });

  it("retries one or every dead event and purges done rows past retention", async () => {
    const { queue, clock, rows } = await make({ maxAttempts: 1 });
    queue.on("x", async () => {
      throw new Error("no");
    });
    await queue.emit("x", { id: "a" });
    await queue.emit("x", { id: "b" });
    await queue.emit("y", {});
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
