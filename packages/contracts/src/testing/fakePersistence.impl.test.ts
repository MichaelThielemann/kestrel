import { describe, it, expect } from "vitest";
import { atomicScopeTests } from "../atomic.contract.test.ts";
import { persistenceContractTests } from "../persistence.contract.test.ts";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";

persistenceContractTests(async () => createFakePersistence());

atomicScopeTests(async () => {
  const db = createFakePersistence();
  db.scopeTimeoutMs = 500;
  db.acquireTimeoutMs = 50;
  return { db, scope: (info, body) => db.scope(info, body), close: async () => {}, acquireTimeoutMs: db.acquireTimeoutMs };
});

describe("fakePersistence.failNext", () => {
  it("fails the next call only, without touching the store", async () => {
    const db = createFakePersistence();
    expectOk(await db.ensureCollection("things", { name: "string" }));
    expectOk(await db.createOne("things", { id: "a", name: "alpha" }));

    db.failNext("TRANSIENT");
    const transient = expectErr(await db.findOne("things", { id: "a" }), "TRANSIENT");
    expect(transient.status).toBe(503);
    expect(transient.retryable).toBe(true);

    expect(expectOk(await db.findOne("things", { id: "a" }))).toMatchObject({ id: "a", name: "alpha" });

    db.failNext("CONFLICT");
    expect(expectErr(await db.createOne("things", { id: "b", name: "beta" }), "CONFLICT").status).toBe(409);
    expect(expectOk(await db.findOne("things", { id: "b" }))).toBeNull();
  });
});

describe("fakePersistence.failScope", () => {
  it("fails the next scope in the named phase and restores the pre-scope state", async () => {
    const db = createFakePersistence();
    expectOk(await db.ensureCollection("things", { name: "string" }));

    db.failScope("begin");
    const begin = await db.scope({ pipeline: "p", group: 1 }, async () => "commit");
    expect(begin.kind).toBe("failed");
    if (begin.kind === "failed") expect(begin.phase).toBe("begin");

    db.failScope("commit");
    const commit = await db.scope({ pipeline: "p", group: 1 }, async () => {
      await db.createOne("things", { id: "a", name: "alpha" });
      return "commit";
    });
    expect(commit.kind).toBe("failed");
    if (commit.kind === "failed") expect(commit.phase).toBe("commit");
    expect(expectOk(await db.findOne("things", { id: "a" }))).toBeNull();

    db.failScope("rollback");
    const rollback = await db.scope({ pipeline: "p", group: 1 }, async () => "rollback");
    expect(rollback.kind).toBe("failed");
    if (rollback.kind === "failed") expect(rollback.phase).toBe("rollback");
  });
});
