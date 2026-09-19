import { describe, expect, it } from "vitest";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { COLLECTION, type Audit } from "./impl.ts";
import module from "./module.ts";

function makeDeps(db: ReturnType<typeof createFakePersistence>): Deps {
  const providers = new Map<string, unknown>([[PERSISTENCE.name, db]]);
  return {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers.get(contract.name), "host"),
    logger: silentLogger,
    root: process.cwd(),
  };
}

async function boot(config: Record<string, unknown> = {}): Promise<{ instance: Audit; db: ReturnType<typeof createFakePersistence> }> {
  const db = createFakePersistence();
  const instance = boundaryCast<Audit>(await module.setup(module.configSchema.parse(config), makeDeps(db)), "host");
  return { instance, db };
}

const recordPipeline = definePipeline({ name: "record", steps: ["audit.record"] });
const anonymizePipeline = definePipeline({ name: "anonymize", steps: ["audit.anonymize"] });
const prunePipeline = definePipeline({ name: "prune", steps: ["audit.prune"] });

describe("audit/persistence module steps via runPipeline", () => {
  it("record persists an entry built from the event envelope", async () => {
    const { instance, db } = await boot();
    const res = await runPipeline(recordPipeline, { body: { eventId: "e1", event: "auth.loggedIn", at: 1, identity: { id: "u1", claims: {} }, params: {} } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect(expectOk(await db.count(COLLECTION, { event: "auth.loggedIn", identityId: "u1" }))).toBe(1);
  });

  it("record accepts an anonymous event with no identity", async () => {
    const { instance, db } = await boot();
    const res = await runPipeline(recordPipeline, { body: { eventId: null, event: "auth.loggedOut", at: 2, identity: null, params: {} } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect(expectOk(await db.count(COLLECTION, { event: "auth.loggedOut", identityId: null }))).toBe(1);
  });

  it("anonymize strips the user the event payload names and is repeatable", async () => {
    const { instance, db } = await boot();
    await runPipeline(recordPipeline, { body: { eventId: "e1", event: "auth.loggedIn", at: 1, identity: { id: "u1", claims: {} }, params: {} } }, { modules: [{ module, instance }] });

    const first = await runPipeline(anonymizePipeline, { payload: { id: "u1", event: "user.deleted", at: 2, identity: null, params: { id: "u1" } } }, { modules: [{ module, instance }] });
    expect(first.status).toBe(200);
    expect(first.result).toEqual({ entries: 1 });
    expect(expectOk(await db.count(COLLECTION, { identityId: "u1" }))).toBe(0);

    const again = await runPipeline(anonymizePipeline, { params: { id: "u1" } }, { modules: [{ module, instance }] });
    expect(again.result).toEqual({ entries: 0 });
  });

  it("anonymize answers 400 without a user id", async () => {
    const { instance } = await boot();
    const res = await runPipeline(anonymizePipeline, {}, { modules: [{ module, instance }] });
    expect(res).toMatchObject({ status: 400, code: "VALIDATION" });
  });

  it("prune removes what retentionDays no longer covers and answers 400 when it is unset", async () => {
    const { instance, db } = await boot({ retentionDays: 30 });
    await runPipeline(recordPipeline, { body: { eventId: "old", event: "auth.loggedIn", at: 1, identity: null, params: {} } }, { modules: [{ module, instance }] });
    await runPipeline(recordPipeline, { body: { eventId: "new", event: "auth.loggedIn", at: Date.now(), identity: null, params: {} } }, { modules: [{ module, instance }] });

    const pruned = await runPipeline(prunePipeline, {}, { modules: [{ module, instance }] });
    expect(pruned.status).toBe(200);
    expect(pruned.result).toEqual({ removed: 1 });
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);

    const { instance: unset } = await boot();
    expect(await runPipeline(prunePipeline, {}, { modules: [{ module, instance: unset }] })).toMatchObject({ status: 400, code: "VALIDATION" });
  });
});
