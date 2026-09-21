import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicScopeTests } from "@michaelthielemann/kestrel-contracts/atomic.contract.test";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createPersistenceSqlite } from "./impl.ts";
import module, { configSchema } from "./module.ts";

function tempFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-atomic-"));
  return { file: join(dir, "t.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

atomicScopeTests(async () => {
  const db = createPersistenceSqlite({ file: ":memory:", scopeTimeoutMs: 100 });
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
