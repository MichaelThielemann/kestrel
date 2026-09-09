import { describe, expect, it } from "vitest";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
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
      return providers.get(contract.name) as T;
    },
    find: <T>(contract: Contract<T>): T | undefined => providers.get(contract.name) as T | undefined,
    logger: silentLogger,
    root: process.cwd(),
  };
}

async function boot(): Promise<{ instance: Audit; db: ReturnType<typeof createFakePersistence> }> {
  const db = createFakePersistence();
  const instance = (await module.setup(module.configSchema.parse({}), makeDeps(db))) as Audit;
  return { instance, db };
}

const recordPipeline = definePipeline({ name: "record", steps: ["audit.record"] });

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
});
