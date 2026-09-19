import { describe, expect, it } from "vitest";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
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
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers.get(contract.name), "host"),
    logger: silentLogger,
    root: process.cwd(),
  };
}

async function boot(): Promise<{ instance: AuthnMulti }> {
  const db = createFakePersistence();
  const instance = boundaryCast<AuthnMulti>(await module.setup(configSchema.parse({ minPasswordLength: 8 }), makeDeps(db)), "host");
  return { instance };
}

function problems(details: Record<string, unknown> | undefined): Array<{ path: string; message: string }> {
  return boundaryCast<{ problems: Array<{ path: string; message: string }> }>(details, "json").problems;
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
const updateUserPipeline = definePipeline({ name: "updateUser", steps: ["authn.updateUser"] });
const deleteUserPipeline = definePipeline({ name: "deleteUser", steps: ["authn.requireUser", "authn.deleteUser"] });
const deleteUserAsAdminPipeline = definePipeline({ name: "deleteUserAsAdmin", steps: ["authn.deleteUser"] });
const deactivateUserPipeline = definePipeline({ name: "deactivateUser", steps: ["authn.deactivateUser"] });
const activateUserPipeline = definePipeline({ name: "activateUser", steps: ["authn.activateUser"] });
const cleanupSessionsPipeline = definePipeline({ name: "cleanupSessions", steps: ["authn.cleanupSessions"] });

describe("authn/multi module steps via runPipeline", () => {
  it("createUser creates an account", async () => {
    const { instance } = await boot();
    const res = await runPipeline(createUserPipeline, { body: { username: "alice", password: "long-enough", roles: ["editor"] } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect(boundaryCast<{ username: string }>(res.result, "json").username).toBe("alice");
  });

  it("login, identifyUser, requireUser, loadIdentity, changePassword and logout round-trip", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "bob", password: "long-enough" } }, { modules: [{ module, instance }] });
    expect(created.status).toBe(200);

    const loggedIn = await runPipeline(loginPipeline, { body: { username: "bob", password: "long-enough" } }, { modules: [{ module, instance }] });
    expect(loggedIn.status).toBe(200);
    const token = boundaryCast<{ token: string }>(loggedIn.result, "json").token;
    const headers = { authorization: `Bearer ${token}` };

    const identified = await runPipeline(identifyPipeline, { headers }, { modules: [{ module, instance }] });
    expect(identified.status).toBe(200);

    const required = await runPipeline(requirePipeline, { headers }, { modules: [{ module, instance }] });
    expect(required.status).toBe(200);

    const loaded = await runPipeline(loadIdentityPipeline, { headers }, { modules: [{ module, instance }] });
    expect(loaded.status).toBe(200);
    expect(boundaryCast<{ id: string }>(loaded.result, "json").id).toBeTypeOf("string");

    const changed = await runPipeline(changePasswordPipeline, { headers, body: { currentPassword: "long-enough", newPassword: "even-longer" } }, { modules: [{ module, instance }] });
    expect(changed.status).toBe(200);

    const loggedOut = await runPipeline(logoutPipeline, { headers }, { modules: [{ module, instance }] });
    expect(loggedOut.status).toBe(200);
  });

  it("listUsers, getUser, setPassword, deactivateUser, activateUser and cleanupSessions", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const id = boundaryCast<{ id: string }>(created.result, "json").id;

    const listed = await runPipeline(listUsersPipeline, {}, { modules: [{ module, instance }] });
    expect(listed.status).toBe(200);
    expect(boundaryCast<unknown[]>(listed.result, "json").length).toBe(1);

    const got = await runPipeline(getUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(got.status).toBe(200);
    expect(boundaryCast<{ id: string }>(got.result, "json").id).toBe(id);

    const passwordSet = await runPipeline(setPasswordPipeline, { params: { id }, body: { password: "brand-new-pass" } }, { modules: [{ module, instance }] });
    expect(passwordSet.status).toBe(200);

    const deactivated = await runPipeline(deactivateUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(deactivated.status).toBe(200);

    const activated = await runPipeline(activateUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(activated.status).toBe(200);

    const cleaned = await runPipeline(cleanupSessionsPipeline, {}, { modules: [{ module, instance }] });
    expect(cleaned.status).toBe(200);
    expect(boundaryCast<{ removed: number }>(cleaned.result, "json").removed).toBe(0);
  });

  it("updateUser renames a user and answers 409 for a name that is taken", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const id = boundaryCast<{ id: string }>(created.result, "json").id;
    await runPipeline(createUserPipeline, { body: { username: "dora", password: "long-enough" } }, { modules: [{ module, instance }] });

    const renamed = await runPipeline(updateUserPipeline, { params: { id }, body: { username: "caro", roles: ["editor"] } }, { modules: [{ module, instance }] });
    expect(renamed.status).toBe(200);
    expect(renamed.result).toMatchObject({ id, username: "caro", roles: ["editor"] });

    const taken = await runPipeline(updateUserPipeline, { params: { id }, body: { username: "dora" } }, { modules: [{ module, instance }] });
    expect(taken).toMatchObject({ status: 409, code: "CONFLICT" });

    const unknownField = await runPipeline(updateUserPipeline, { params: { id }, body: { email: "x@example.org" } }, { modules: [{ module, instance }] });
    expect(unknownField.status).toBe(400);
    expect(problems(unknownField.details)[0]?.path).toBe("$.email");
  });

  it("deleteUser removes a user but never the caller themselves", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const id = boundaryCast<{ id: string }>(created.result, "json").id;
    const loggedIn = await runPipeline(loginPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const headers = { authorization: `Bearer ${boundaryCast<{ token: string }>(loggedIn.result, "json").token}` };

    const self = await runPipeline(deleteUserPipeline, { params: { id }, headers }, { modules: [{ module, instance }] });
    expect(self).toMatchObject({ status: 400, code: "VALIDATION" });

    const other = await runPipeline(createUserPipeline, { body: { username: "dora", password: "long-enough" } }, { modules: [{ module, instance }] });
    const otherId = boundaryCast<{ id: string }>(other.result, "json").id;
    const deleted = await runPipeline(deleteUserPipeline, { params: { id: otherId }, headers }, { modules: [{ module, instance }] });
    expect(deleted.status).toBe(200);
    const gone = await runPipeline(getUserPipeline, { params: { id: otherId } }, { modules: [{ module, instance }] });
    expect(gone).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("deleteUser reports the reassign target it resolved, and none without one", async () => {
    const { instance } = await boot();
    const carol = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const carolId = boundaryCast<{ id: string }>(carol.result, "json").id;
    const dora = await runPipeline(createUserPipeline, { body: { username: "dora", password: "long-enough" } }, { modules: [{ module, instance }] });
    const doraId = boundaryCast<{ id: string }>(dora.result, "json").id;
    const erin = await runPipeline(createUserPipeline, { body: { username: "erin", password: "long-enough" } }, { modules: [{ module, instance }] });
    const erinId = boundaryCast<{ id: string }>(erin.result, "json").id;

    const reassigned = await runPipeline(deleteUserAsAdminPipeline, { params: { id: carolId }, body: { reassignTo: doraId } }, { modules: [{ module, instance }] });
    expect(reassigned.status).toBe(200);
    expect(reassigned.result).toEqual({ ok: true, reassignTo: { id: doraId, name: "dora" } });

    const anonymised = await runPipeline(deleteUserAsAdminPipeline, { params: { id: erinId } }, { modules: [{ module, instance }] });
    expect(anonymised.result).toEqual({ ok: true, reassignTo: null });
  });

  it("deleteUser keeps the user when the reassign target is unknown, inactive, themselves or not an id", async () => {
    const { instance } = await boot();
    const carol = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const carolId = boundaryCast<{ id: string }>(carol.result, "json").id;
    const dora = await runPipeline(createUserPipeline, { body: { username: "dora", password: "long-enough" } }, { modules: [{ module, instance }] });
    const doraId = boundaryCast<{ id: string }>(dora.result, "json").id;
    await runPipeline(deactivateUserPipeline, { params: { id: doraId } }, { modules: [{ module, instance }] });

    const unknown = await runPipeline(deleteUserAsAdminPipeline, { params: { id: carolId }, body: { reassignTo: "nobody" } }, { modules: [{ module, instance }] });
    expect(unknown).toMatchObject({ status: 404, code: "NOT_FOUND" });

    const inactive = await runPipeline(deleteUserAsAdminPipeline, { params: { id: carolId }, body: { reassignTo: doraId } }, { modules: [{ module, instance }] });
    expect(inactive).toMatchObject({ status: 400, code: "VALIDATION" });

    const itself = await runPipeline(deleteUserAsAdminPipeline, { params: { id: carolId }, body: { reassignTo: carolId } }, { modules: [{ module, instance }] });
    expect(itself).toMatchObject({ status: 400, code: "VALIDATION" });

    const wrongType = await runPipeline(deleteUserAsAdminPipeline, { params: { id: carolId }, body: { reassignTo: 7 } }, { modules: [{ module, instance }] });
    expect(wrongType).toMatchObject({ status: 400, code: "VALIDATION" });

    expect((await runPipeline(getUserPipeline, { params: { id: carolId } }, { modules: [{ module, instance }] })).status).toBe(200);
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
