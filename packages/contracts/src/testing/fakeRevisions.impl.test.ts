import { describe, it, expect } from "vitest";
import { revisionsContractTests } from "../revisions.contract.test.ts";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createFakeRevisions } from "@michaelthielemann/kestrel-contracts/testing/fakeRevisions";

revisionsContractTests(async (options) => createFakeRevisions(options));

describe("fakeRevisions", () => {
  it("keeps 50 revisions per document and locale without a configured limit", async () => {
    const revisions = createFakeRevisions();
    for (let i = 0; i < 60; i += 1) {
      expectOk(await revisions.record({ collection: "pages", documentId: "p1", locale: "de", fields: { title: `v${i}` }, author: { id: null, name: null }, kind: "save" }));
    }
    expectOk(await revisions.prune());
    expect(expectOk(await revisions.list("pages", "p1", "de")).total).toBe(50);
  });
});
