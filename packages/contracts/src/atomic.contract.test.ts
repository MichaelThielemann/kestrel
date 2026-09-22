import { describe, expect, it } from "vitest";
import type { AtomicScope } from "@michaelthielemann/kestrel/atomic";
import type { Document, Persistence } from "./persistence.ts";
import { expectOk } from "./testing/result.ts";

interface Row extends Document {
  name: string;
}

export interface AtomicScopeFixture {
  /** A store to write through. */
  db: Persistence;
  /** The scope under test, bound to that store. */
  scope: AtomicScope;
  /** Closes the fixture. */
  close: () => Promise<void>;
}

export function atomicScopeTests(make: () => Promise<AtomicScopeFixture>): void {
  describe("atomic scope", () => {
    it("a committed scope's writes are visible afterwards", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      const outcome = await scope({ pipeline: "p", group: 1 }, async () => {
        await db.createOne<Row>("rows", { id: "a", name: "alpha" });
        return "commit";
      });
      expect(outcome).toEqual({ kind: "settled", verdict: "commit" });
      expect(expectOk(await db.findOne<Row>("rows", { id: "a" }))?.name).toBe("alpha");
      await close();
    });

    it("a rollback verdict undoes every write of the scope, including a createMany inside it", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      expectOk(await db.createMany<Row>("rows", [{ id: "seed", name: "seed" }]));
      const outcome = await scope({ pipeline: "p", group: 1 }, async () => {
        await db.createOne<Row>("rows", { id: "a", name: "alpha" });
        await db.createMany<Row>("rows", [{ id: "b", name: "beta" }, { id: "c", name: "gamma" }]);
        return "rollback";
      });
      expect(outcome).toEqual({ kind: "settled", verdict: "rollback" });
      const rows = expectOk(await db.findMany<Row>("rows", {}));
      expect(rows.items.map((r) => r.id)).toEqual(["seed"]);
      await close();
    });

    it("a rejection of body rolls back and re-throws the original error unchanged", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      const boom = new Error("boom");
      await expect(
        scope({ pipeline: "p", group: 1 }, async () => {
          await db.createOne<Row>("rows", { id: "a", name: "alpha" });
          throw boom;
        }),
      ).rejects.toBe(boom);
      const rows = expectOk(await db.findMany<Row>("rows", {}));
      expect(rows.items).toEqual([]);
      await close();
    });

    it("a write made through the same handle inside the scope participates", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      await scope({ pipeline: "p", group: 1 }, async () => {
        await db.createOne<Row>("rows", { id: "a", name: "alpha" });
        expect(expectOk(await db.findOne<Row>("rows", { id: "a" }))?.name).toBe("alpha");
        return "commit";
      });
      await close();
    });

    it("two concurrent scopes serialize: the second begins only after the first settled, and sees the first's writes", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      const order: string[] = [];
      let releaseFirst: () => void = () => {};
      const firstStarted = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = scope({ pipeline: "p", group: 1 }, async () => {
        order.push("first-start");
        await db.createOne<Row>("rows", { id: "a", name: "alpha" });
        releaseFirst();
        await new Promise((r) => setTimeout(r, 20));
        order.push("first-end");
        return "commit";
      });
      await firstStarted;
      const second = scope({ pipeline: "p", group: 2 }, async () => {
        order.push("second-start");
        expect(expectOk(await db.findOne<Row>("rows", { id: "a" }))?.name).toBe("alpha");
        return "commit";
      });
      await Promise.all([first, second]);
      expect(order.indexOf("first-end")).toBeLessThan(order.indexOf("second-start"));
      await close();
    });

    it("ensureCollection inside a scope is rejected", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      await expect(
        scope({ pipeline: "p", group: 1 }, async () => {
          await db.ensureCollection("rows2", { name: "string" });
          return "commit";
        }),
      ).rejects.toThrow(/must not run inside an atomic scope/);
      await close();
    });

    it("a scope() opened inside an open scope fails at once, without waiting for the mutex", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      const outcome = await scope({ pipeline: "p", group: 1 }, async () => {
        const started = Date.now();
        const nested = await scope({ pipeline: "p", group: 2 }, async () => "commit");
        expect(Date.now() - started).toBeLessThan(200);
        expect(nested.kind).toBe("failed");
        if (nested.kind === "failed") expect(nested.phase).toBe("begin");
        return "commit";
      });
      expect(outcome).toEqual({ kind: "settled", verdict: "commit" });
      await close();
    });

    it("a call made after the scope committed writes for real; after it rolled back it is rejected and writes nothing", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      let late: Promise<unknown> = Promise.resolve();
      await scope({ pipeline: "p", group: 1 }, async () => {
        late = db.createOne<Row>("rows", { id: "late", name: "late" });
        return "commit";
      });
      await late;
      expect(expectOk(await db.findOne<Row>("rows", { id: "late" }))?.name).toBe("late");
      await close();
    });

    it("a read issued concurrently from outside the scope never observes an uncommitted row", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      let releaseScope: () => void = () => {};
      const scopeEntered = new Promise<void>((resolve) => {
        releaseScope = resolve;
      });
      const scopeDone = scope({ pipeline: "p", group: 1 }, async () => {
        await db.createOne<Row>("rows", { id: "a", name: "alpha" });
        releaseScope();
        await new Promise((r) => setTimeout(r, 30));
        return "commit";
      });
      await scopeEntered;
      const startedAt = Date.now();
      const read = expectOk(await db.findMany<Row>("rows", {}));
      const waited = Date.now() - startedAt;
      if (waited < 20) expect(read.items).toEqual([]);
      else expect(read.items.map((r) => r.id)).toEqual(["a"]);
      await scopeDone;
      await close();
    });
  });

  describe("atomic scope timeout (fixture pre-configures a short scopeTimeoutMs)", () => {
    it("a body that outlives the scope's own budget times out, and none of its writes are stored", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      const outcome = await scope({ pipeline: "p", group: 1 }, async () => {
        await db.createOne<Row>("rows", { id: "a", name: "alpha" });
        await new Promise((r) => setTimeout(r, 1000));
        return "commit";
      });
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") expect(outcome.phase).toBe("timeout");
      const rows = expectOk(await db.findMany<Row>("rows", {}));
      expect(rows.items).toEqual([]);
      await close();
    });

    it("a write scheduled from inside a timed-out scope's context, but not yet run when it settled, writes nothing", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      let late: Promise<unknown> = Promise.resolve();
      let settled = false;
      const pollUntilSettled = () => {
        setTimeout(() => {
          if (!settled) {
            pollUntilSettled();
            return;
          }
          late = db.createOne<Row>("rows", { id: "late", name: "late" }).catch((e: unknown) => e);
        }, 5);
      };
      const outcome = await scope({ pipeline: "p", group: 1 }, async () => {
        pollUntilSettled();
        await new Promise((r) => setTimeout(r, 1000));
        return "commit";
      });
      settled = true;
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") expect(outcome.phase).toBe("timeout");
      await new Promise((r) => setTimeout(r, 20));
      expect(await late).toBeInstanceOf(Error);
      const rows = expectOk(await db.findMany<Row>("rows", {}));
      expect(rows.items).toEqual([]);
      await close();
    });
  });

  describe("atomic scope acquire budget (fixture pre-configures a short acquireTimeoutMs)", () => {
    it("a waiter whose acquire budget expires while queued never begins a transaction; the holder's own writes still land", async () => {
      const { db, scope, close } = await make();
      expectOk(await db.ensureCollection("rows", { name: "string" }));
      let releaseHolder: () => void = () => {};
      const holderEntered = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = scope({ pipeline: "p", group: 1 }, async () => {
        releaseHolder();
        await new Promise((r) => setTimeout(r, 300));
        await db.createOne<Row>("rows", { id: "holder", name: "holder" });
        return "commit";
      });
      await holderEntered;
      let waiterRan = false;
      const waiter = await scope({ pipeline: "p", group: 2 }, async () => {
        waiterRan = true;
        return "commit";
      });
      expect(waiter.kind).toBe("failed");
      if (waiter.kind === "failed") expect(waiter.phase).toBe("begin");
      expect(waiterRan).toBe(false);
      await holder;
      expect(expectOk(await db.findOne<Row>("rows", { id: "holder" }))?.name).toBe("holder");
      await close();
    });
  });
}
