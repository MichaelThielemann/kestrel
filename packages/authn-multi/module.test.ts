import { describe, expect, it } from "vitest";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { AuthnMulti } from "./impl.ts";
import module, { configSchema } from "./module.ts";

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

async function boot(): Promise<{ instance: AuthnMulti }> {
  const db = createFakePersistence();
  const instance = (await module.setup(configSchema.parse({ minPasswordLength: 8 }), makeDeps(db))) as AuthnMulti;
  return { instance };
}

function problems(details: Record<string, unknown> | undefined): Array<{ path: string; message: string }> {
  return (details as { problems: Array<{ path: string; message: string }> }).problems;
}

const loginPipeline = definePipeline({ name: "login", steps: ["authn.login"] });
const identifyPipeline = definePipeline({ name: "identify", steps: ["authn.identifyUser"] });
const requirePipeline = definePipeline({ name: "require", steps: ["authn.requireUser"] });
const loadIdentityPipeline = definePipeline({ name: "loadIdentity", steps: ["authn.requireUser", "authn.loadIdentity"] });
const logoutPipeline = definePipeline({ name: "logout", steps: ["authn.requireUser", "authn.logout"] });
const createUserPipeline = definePipeline({ name: "createUser", steps: ["authn.createUser"] });
const listUsersPipeline = definePipeline({ name: "listUsers", steps: ["authn.listUsers"] });
const getUserPipeline = definePipeline({ name: "getUser", steps: ["authn.getUser"] });
const setPasswordPipeline = definePipeline({ name: "setPassword", steps: ["authn.setPassword"] });
const changePasswordPipeline = definePipeline({ name: "changePassword", steps: ["authn.requireUser", "authn.changePassword"] });
const deactivateUserPipeline = definePipeline({ name: "deactivateUser", steps: ["authn.deactivateUser"] });
const activateUserPipeline = definePipeline({ name: "activateUser", steps: ["authn.activateUser"] });
const cleanupSessionsPipeline = definePipeline({ name: "cleanupSessions", steps: ["authn.cleanupSessions"] });

describe("authn/multi module steps via runPipeline", () => {
  it("createUser creates an account", async () => {
    const { instance } = await boot();
    const res = await runPipeline(createUserPipeline, { body: { username: "alice", password: "long-enough", roles: ["editor"] } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect((res.result as { username: string }).username).toBe("alice");
  });

  it("login, identifyUser, requireUser, loadIdentity, changePassword and logout round-trip", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "bob", password: "long-enough" } }, { modules: [{ module, instance }] });
    expect(created.status).toBe(200);

    const loggedIn = await runPipeline(loginPipeline, { body: { username: "bob", password: "long-enough" } }, { modules: [{ module, instance }] });
    expect(loggedIn.status).toBe(200);
    const token = (loggedIn.result as { token: string }).token;
    const headers = { authorization: `Bearer ${token}` };

    const identified = await runPipeline(identifyPipeline, { headers }, { modules: [{ module, instance }] });
    expect(identified.status).toBe(200);

    const required = await runPipeline(requirePipeline, { headers }, { modules: [{ module, instance }] });
    expect(required.status).toBe(200);

    const loaded = await runPipeline(loadIdentityPipeline, { headers }, { modules: [{ module, instance }] });
    expect(loaded.status).toBe(200);
    expect((loaded.result as { id: string }).id).toBeTypeOf("string");

    const changed = await runPipeline(changePasswordPipeline, { headers, body: { currentPassword: "long-enough", newPassword: "even-longer" } }, { modules: [{ module, instance }] });
    expect(changed.status).toBe(200);

    const loggedOut = await runPipeline(logoutPipeline, { headers }, { modules: [{ module, instance }] });
    expect(loggedOut.status).toBe(200);
  });

  it("listUsers, getUser, setPassword, deactivateUser, activateUser and cleanupSessions", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const id = (created.result as { id: string }).id;

    const listed = await runPipeline(listUsersPipeline, {}, { modules: [{ module, instance }] });
    expect(listed.status).toBe(200);
    expect((listed.result as unknown[]).length).toBe(1);

    const got = await runPipeline(getUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(got.status).toBe(200);
    expect((got.result as { id: string }).id).toBe(id);

    const passwordSet = await runPipeline(setPasswordPipeline, { params: { id }, body: { password: "brand-new-pass" } }, { modules: [{ module, instance }] });
    expect(passwordSet.status).toBe(200);

    const deactivated = await runPipeline(deactivateUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(deactivated.status).toBe(200);

    const activated = await runPipeline(activateUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(activated.status).toBe(200);

    const cleaned = await runPipeline(cleanupSessionsPipeline, {}, { modules: [{ module, instance }] });
    expect(cleaned.status).toBe(200);
    expect((cleaned.result as { removed: number }).removed).toBe(0);
  });

  it("login answers 400 VALIDATION when a field has the wrong type", async () => {
    const { instance } = await boot();
    const res = await runPipeline(loginPipeline, { body: { username: ["a"], password: "x" } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(problems(res.details)[0]?.path).toBe("$.username");
  });

  it("createUser answers 400 VALIDATION on an unexpected field (additionalProperties: false)", async () => {
    const { instance } = await boot();
    const res = await runPipeline(createUserPipeline, { body: { username: "dan", password: "long-enough", extra: true } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(problems(res.details)[0]?.path).toBe("$.extra");
  });
});
