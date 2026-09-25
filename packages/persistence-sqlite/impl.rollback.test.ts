import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createPersistenceSqlite } from "./impl.ts";

async function withFailingExec<T>(failures: readonly { sql: string; error: () => Error }[], fn: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to be re-invoked with an explicit `this` via `.call()` below
  const original = DatabaseSync.prototype.exec;
  const queue = [...failures];
  DatabaseSync.prototype.exec = function failingExec(this: DatabaseSync, sql: string) {
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

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  return { errors, logger: { step() {}, info() {}, warn() {}, error: (message) => errors.push(message) } };
}

const rollbackFailure = () => new Error("simulated rollback failure");
const busy = () => Object.assign(new Error("database is locked"), { errcode: 5 });

describe("persistence/sqlite createMany: a ROLLBACK that fails leaves the store unusable", () => {
  it("after a failed insert, the call answers TRANSIENT, health() asks for a restart, and later calls answer TRANSIENT", async () => {
    const { logger, errors } = recordingLogger();
    const db = createPersistenceSqlite({ file: ":memory:" }, { logger });
    expectOk(await db.ensureCollection("rows", { name: { type: "string", unique: true } }));
    expectOk(await db.createOne("rows", { id: "seed", name: "seed" }));

    const result = await withFailingExec([{ sql: "ROLLBACK", error: rollbackFailure }], () =>
      db.createMany("rows", [
        { id: "a", name: "alpha" },
        { id: "b", name: "seed" },
      ]),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "TRANSIENT", status: 503, retryable: true } });
    expect(result.ok === false && result.error.details?.reason).toEqual(expect.stringContaining("restart"));
    expect(db.health()).toMatchObject({ ok: false, restartRequired: true });
    expect(errors).toEqual([expect.stringContaining("rollback failed")]);
    expect(await db.findMany("rows", {})).toMatchObject({ ok: false, error: { code: "TRANSIENT" } });
    db.close();
  });

  it("after a failed COMMIT, the call answers TRANSIENT and health() asks for a restart", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));

    const result = await withFailingExec(
      [
        { sql: "COMMIT", error: busy },
        { sql: "ROLLBACK", error: rollbackFailure },
      ],
      () => db.createMany("rows", [{ id: "a", name: "alpha" }]),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "TRANSIENT", retryable: true } });
    expect(db.health()).toMatchObject({ ok: false, restartRequired: true });
    db.close();
  });

  it("after a wiring error, the wiring error is still thrown and health() asks for a restart", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));

    const call = withFailingExec([{ sql: "ROLLBACK", error: rollbackFailure }], () => db.createMany("rows", [{ id: "a", name: "alpha", color: "red" }]));

    await expect(call).rejects.toThrow(/unknown field "color"/);
    expect(db.health()).toMatchObject({ ok: false, restartRequired: true });
    db.close();
  });

  it("a COMMIT that throws is rolled back before its error is thrown, and the store keeps serving", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: "string" }));

    const call = withFailingExec([{ sql: "COMMIT", error: () => new Error("simulated commit failure") }], () => db.createMany("rows", [{ id: "a", name: "alpha" }]));

    await expect(call).rejects.toThrow(/simulated commit failure/);
    expect(db.health()).toEqual({ ok: true });
    expectOk(await db.createMany("rows", [{ id: "b", name: "beta" }]));
    expect(expectOk(await db.findMany("rows", {})).items.map((row) => row.id)).toEqual(["b"]);
    db.close();
  });

  it("a ROLLBACK that succeeds keeps the store usable", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("rows", { name: { type: "string", unique: true } }));
    expectOk(await db.createOne("rows", { id: "seed", name: "seed" }));

    const result = await db.createMany("rows", [
      { id: "a", name: "alpha" },
      { id: "b", name: "seed" },
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(db.health()).toEqual({ ok: true });
    expect(expectOk(await db.findMany("rows", {})).items.map((row) => row.id)).toEqual(["seed"]);
    db.close();
  });
});
