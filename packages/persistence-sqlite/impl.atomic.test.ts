import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { atomicScopeTests } from "@michaelthielemann/kestrel-contracts/atomic.contract.test";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Context } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { createPersistenceSqlite } from "./impl.ts";
import module, { configSchema } from "./module.ts";

function tempFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-atomic-"));
  return { file: join(dir, "t.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withPatchedExec<T>(matches: readonly { sql: string; error: () => Error }[], fn: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to be re-invoked with an explicit `this` via `.call()` below
  const original = DatabaseSync.prototype.exec;
  const queue = [...matches];
  DatabaseSync.prototype.exec = function patchedExec(this: DatabaseSync, sql: string) {
    if (queue[0]?.sql === sql) {
      const { error } = queue.shift()!;
      throw error();
    }
    return original.call(this, sql);
  };
  try {
    return await fn();
  } finally {
    DatabaseSync.prototype.exec = original;
  }
}

atomicScopeTests(async () => {
  const db = createPersistenceSqlite({ file: ":memory:", scopeTimeoutMs: 500, acquireTimeoutMs: 50 });
  return { db, scope: (info, body) => db.scope(info, body), close: async () => db.close() };
});

describe("persistence/sqlite atomic scope", () => {
  it("createMany joins an outer scope; a unique violation rolls all of it back", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: { type: "string", unique: true } }));
    expectOk(await db.createOne("rows", { id: "seed", name: "seed" }));

    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => {
      const created = await db.createMany("rows", [
        { id: "a", name: "alpha" },
        { id: "b", name: "seed" },
      ]);
      return created.ok ? "commit" : "rollback";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "rollback" });
    const rows = expectOk(await db.findMany("rows", {}));
    expect(rows.items.map((r) => r.id)).toEqual(["seed"]);
    db.close();
  });

  it("a late call after a committed scope takes the queued path and writes for real", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    let late: Promise<unknown> = Promise.resolve();
    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => {
      late = db.createOne("rows", { id: "late", name: "late" });
      return "commit";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "commit" });
    await late;
    expect(expectOk(await db.findOne("rows", { id: "late" }))?.name).toBe("late");
    db.close();
  });

  it("a late call after a timed-out scope is rejected and writes nothing", async () => {
    const db = createPersistenceSqlite({ file: ":memory:", scopeTimeoutMs: 50 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    let late: Promise<unknown> = Promise.resolve();
    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => {
      await new Promise((r) => setTimeout(r, 200));
      late = db.createOne("rows", { id: "late", name: "late" }).catch((e: unknown) => e);
      return "commit";
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.phase).toBe("timeout");
    await new Promise((r) => setTimeout(r, 250));
    const lateResult = await late;
    expect(lateResult).toBeInstanceOf(Error);
    expect(lateResult instanceof Error && lateResult.message).toMatch(/atomic scope was rolled back/);
    const rows = expectOk(await db.findMany("rows", {}));
    expect(rows.items).toEqual([]);
    db.close();
  });

  it("a step's un-awaited write, scheduled but not yet run when a later step rolls back, is rejected", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    let late: Promise<unknown> = Promise.resolve();
    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => {
      setTimeout(() => {
        late = db.createOne("rows", { id: "late", name: "late" }).catch((e: unknown) => e);
      }, 10);
      return "rollback";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "rollback" });
    await new Promise((r) => setTimeout(r, 30));
    const lateResult = await late;
    expect(lateResult).toBeInstanceOf(Error);
    expect(lateResult instanceof Error && lateResult.message).toMatch(/atomic scope was rolled back/);
    const rows = expectOk(await db.findMany("rows", {}));
    expect(rows.items).toEqual([]);
    db.close();
  });

  it("ensureCollection throws when called inside a scope", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    await expect(
      db.scope({ pipeline: "p", group: 1 }, async () => {
        await db.ensureCollection("rows2", { name: "string" });
        return "commit";
      }),
    ).rejects.toThrow(/ensureCollection must not run inside an atomic scope/);
    db.close();
  });

  it("a nested scope fails at once, without waiting for the mutex", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => {
      const started = Date.now();
      const nested = await db.scope({ pipeline: "p", group: 2 }, async () => "commit");
      expect(Date.now() - started).toBeLessThan(200);
      expect(nested.kind).toBe("failed");
      if (nested.kind === "failed") expect(nested.phase).toBe("begin");
      return "commit";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "commit" });
    db.close();
  });

  it("a waiter whose acquire budget expires is skipped and never opens a transaction", async () => {
    const { file, cleanup } = tempFile();
    const db = createPersistenceSqlite({ file, acquireTimeoutMs: 100, scopeTimeoutMs: 5000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));

    let releaseFirst: () => void = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = db.scope({ pipeline: "p", group: 1 }, async () => {
      releaseFirst();
      await new Promise((r) => setTimeout(r, 300));
      return "commit";
    });
    await firstEntered;

    const second = db.scope({ pipeline: "p", group: 2 }, async () => "commit");
    const secondOutcome = await second;
    expect(secondOutcome.kind).toBe("failed");
    if (secondOutcome.kind === "failed") {
      expect(secondOutcome.phase).toBe("begin");
      expect(secondOutcome.error.retryable).toBe(true);
    }
    await first;
    db.close();
    cleanup();
  });

  it("acquireTimeoutMs and scopeTimeoutMs are distinct budgets", async () => {
    const db = createPersistenceSqlite({ file: ":memory:", acquireTimeoutMs: 15000, scopeTimeoutMs: 50 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "commit";
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.phase).toBe("timeout");
    db.close();
  });

  it("setup() rejects acquireTimeoutMs equal to busyTimeoutMs, naming the key", () => {
    expect(() => configSchema.parse({ file: ":memory:", busyTimeoutMs: 3000, acquireTimeoutMs: 3000 })).toThrow(/acquireTimeoutMs/);
  });

  it("acquireTimeoutMs and scopeTimeoutMs default to 5000, so an instance that sets neither is rejected", () => {
    expect(() => configSchema.parse({ file: ":memory:" })).toThrow(/must be greater than busyTimeoutMs \(5000\)/);
  });

  it("module.ts declares atomicScope next to teardown", () => {
    expect(typeof module.atomicScope).toBe("function");
  });
});

describe("every BEGIN/COMMIT/ROLLBACK failure inside the scope becomes a value", () => {
  it("a closed database: scope() resolves to a failed outcome instead of rejecting", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    db.close();
    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => "commit");
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.phase).toBe("begin");
  });

  it("a closed database: runPipeline returns a RunResult, it does not reject", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    db.close();
    const pipeline = definePipeline({ name: "p", steps: [{ atomic: ["test.noop"] }] });
    const result = await runPipeline(
      pipeline,
      { trigger: { kind: "http", name: "test" }, payload: {} },
      { logger: silentLogger, atomicScope: (info, body) => db.scope(info, body), steps: { "test.noop": async (ctx: Context) => ok(ctx) } },
    );
    expect(result.status).toBeGreaterThanOrEqual(500);
  });

  it("a COMMIT failure compensates with a real ROLLBACK: the write is undone, a late write is rejected, and the connection keeps serving later requests", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    let late: Promise<unknown> = Promise.resolve();
    const outcome = await withPatchedExec([{ sql: "COMMIT", error: () => new Error("simulated commit failure") }], () =>
      db.scope({ pipeline: "p", group: 1 }, async () => {
        await db.createOne("rows", { id: "a", name: "alpha" });
        setTimeout(() => {
          late = db.createOne("rows", { id: "late", name: "late" }).catch((e: unknown) => e);
        }, 10);
        return "commit";
      }),
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.phase).toBe("commit");
    expect((expectOk(await db.findMany("rows", {}))).total).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(await late).toBeInstanceOf(Error);
    expectOk(await db.createOne("rows", { id: "b", name: "beta" }));
    db.close();
  });

  it("a ROLLBACK failure following a failed COMMIT marks the store unusable, never leaving it silently inside a transaction", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const outcome = await withPatchedExec(
      [
        { sql: "COMMIT", error: () => new Error("simulated commit failure") },
        { sql: "ROLLBACK", error: () => new Error("simulated rollback failure") },
      ],
      () =>
        db.scope({ pipeline: "p", group: 1 }, async () => {
          await db.createOne("rows", { id: "a", name: "alpha" });
          return "commit";
        }),
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.phase).toBe("rollback");
    const after = await db.createOne("rows", { id: "c", name: "gamma" });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("INTERNAL");
    db.close();
  });

  it("a ROLLBACK failure on its own (no prior commit attempt) also marks the store unusable", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const outcome = await withPatchedExec([{ sql: "ROLLBACK", error: () => new Error("simulated rollback failure") }], () =>
      db.scope({ pipeline: "p", group: 1 }, async () => "rollback"),
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.phase).toBe("rollback");
    const after = await db.createOne("rows", { id: "d", name: "delta" });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("INTERNAL");
    db.close();
  });
});

describe("scope() arms its own acquire timer", () => {
  it("answers within acquireTimeoutMs even while a slow holder is still running", async () => {
    const db = createPersistenceSqlite({ file: ":memory:", acquireTimeoutMs: 100, scopeTimeoutMs: 5000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const holder = db.scope({ pipeline: "p", group: 1 }, async () => {
      await new Promise((r) => setTimeout(r, 600));
      return "commit";
    });
    const started = Date.now();
    const waiter = await db.scope({ pipeline: "p", group: 2 }, async () => "commit");
    const elapsed = Date.now() - started;
    expect(waiter.kind).toBe("failed");
    if (waiter.kind === "failed") {
      expect(waiter.phase).toBe("begin");
      expect(waiter.error.retryable).toBe(true);
    }
    expect(elapsed).toBeLessThan(400);
    await holder;
    db.close();
  });
});

describe("checkpoint and snapshot route through the mutex", () => {
  it("checkpoint waits for an open scope to settle", async () => {
    const { file, cleanup } = tempFile();
    const db = createPersistenceSqlite({ file, acquireTimeoutMs: 15000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const order: string[] = [];
    const scopeDone = db.scope({ pipeline: "p", group: 1 }, async () => {
      order.push("scope-start");
      await new Promise((r) => setTimeout(r, 60));
      order.push("scope-end");
      return "commit";
    });
    await new Promise((r) => setTimeout(r, 10));
    await db.checkpoint();
    order.push("checkpoint-done");
    expect(order.indexOf("scope-end")).toBeLessThan(order.indexOf("checkpoint-done"));
    await scopeDone;
    db.close();
    cleanup();
  });

  it("snapshot waits for an open scope to settle", async () => {
    const { file, cleanup } = tempFile();
    const db = createPersistenceSqlite({ file, acquireTimeoutMs: 15000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const order: string[] = [];
    const scopeDone = db.scope({ pipeline: "p", group: 1 }, async () => {
      order.push("scope-start");
      await new Promise((r) => setTimeout(r, 60));
      order.push("scope-end");
      return "commit";
    });
    await new Promise((r) => setTimeout(r, 10));
    await db.snapshot(join(file, "..", "copy.db"));
    order.push("snapshot-done");
    expect(order.indexOf("scope-end")).toBeLessThan(order.indexOf("snapshot-done"));
    await scopeDone;
    db.close();
    cleanup();
  });
});

describe("scope() fails at once while the store is unusable", () => {
  it("does not wait for the mutex and does not touch the database", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    await withPatchedExec([{ sql: "ROLLBACK", error: () => new Error("simulated rollback failure") }], () =>
      db.scope({ pipeline: "p", group: 1 }, async () => "rollback"),
    );
    const started = Date.now();
    const outcome = await db.scope({ pipeline: "p", group: 2 }, async () => "commit");
    expect(Date.now() - started).toBeLessThan(200);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.phase).toBe("begin");
      expect(outcome.error.code).toBe("INTERNAL");
    }
    db.close();
  });
});
