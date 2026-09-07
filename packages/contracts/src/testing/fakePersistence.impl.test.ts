import { describe, it, expect } from "vitest";
import { persistenceContractTests } from "../persistence.contract.test.ts";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";

persistenceContractTests(async () => createFakePersistence());

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
