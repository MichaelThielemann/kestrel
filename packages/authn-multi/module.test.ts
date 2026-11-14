import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHN_STEP_KEYS, authnStepsContractTests, writesByStepOf } from "@michaelthielemann/kestrel-contracts/authn.steps.contract.test";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context, Step } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps, StepDescription } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline, type PipelineDefinition } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { AuthnMulti } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const OBJECT_BINDING_PROOF_FILE = join(process.cwd(), "node_modules", ".cache", "kestrel-object-binding-proofs.ndjson");

function provesObjectBinding(moduleName: string, step: string): void {
  mkdirSync(dirname(OBJECT_BINDING_PROOF_FILE), { recursive: true });
  appendFileSync(OBJECT_BINDING_PROOF_FILE, `${moduleName}#${step}\n`);
}

authnStepsContractTests(async () => {
  const { instance } = await boot();
  const credentials = { username: "alice", password: "long-enough" };
  await runPipeline(definePipeline({ name: "createUser", steps: ["authn.createUser"] }), { body: credentials }, { modules: [{ module, instance }] });
  return { modules: [{ module, instance }], credentials, sessionTtlSeconds: 86400, writesByStep: writesByStepOf("authn", module.describe!(instance), AUTHN_STEP_KEYS) };
});

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
    eventTriggers: [],
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
const EXPOSE_VERIFIED_USER: Record<string, Step> = { "test.exposeVerifiedUser": async (ctx: Context) => ok({ ...ctx, result: ctx.verifiedUser ?? null }) };
const verifyUserPipeline = definePipeline({ name: "verifyUser", steps: ["authn.verifyUser:reassignTo", "test.exposeVerifiedUser"] });
const verifyUserEventPipeline = definePipeline({ name: "verifyUserEvent", steps: ["authn.verifyUser:result.reassignTo", "test.exposeVerifiedUser"] });
const deleteUserAsAdminPipeline = definePipeline({ name: "deleteUserAsAdmin", steps: ["authn.deleteUser"] });
const deactivateUserPipeline = definePipeline({ name: "deactivateUser", steps: ["authn.deactivateUser"] });
const activateUserPipeline = definePipeline({ name: "activateUser", steps: ["authn.activateUser"] });
const requireAbsentUserPipeline = definePipeline({ name: "requireAbsentUser", steps: ["authn.requireAbsentUser"] });
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
    provesObjectBinding("authn/multi", "deleteUser");
  });

  it("requireAbsentUser answers 409 CONFLICT for an active or a deactivated user and passes for a user id that names no user", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const id = boundaryCast<{ id: string }>(created.result, "json").id;

    const active = await runPipeline(requireAbsentUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(active).toMatchObject({ status: 409, code: "CONFLICT" });

    await runPipeline(deactivateUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    const inactive = await runPipeline(requireAbsentUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(inactive).toMatchObject({ status: 409, code: "CONFLICT" });

    await runPipeline(deleteUserAsAdminPipeline, { params: { id } }, { modules: [{ module, instance }] });
    const gone = await runPipeline(requireAbsentUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
    expect(gone.status).toBe(200);

    const unknown = await runPipeline(requireAbsentUserPipeline, { params: { id: randomUUID() } }, { modules: [{ module, instance }] });
    expect(unknown.status).toBe(200);
  });

  it("requireAbsentUser refuses an id that has the shape of no user id with 400 VALIDATION", async () => {
    const { instance } = await boot();
    for (const id of ["never-existed", "mallory", "authn.login", "login", "", "1234"]) {
      const res = await runPipeline(requireAbsentUserPipeline, { params: { id } }, { modules: [{ module, instance }] });
      expect(res, id).toMatchObject({ status: 400, code: "VALIDATION" });
    }
  });

  function verify(pipeline: PipelineDefinition, body: Record<string, unknown>, instance: unknown) {
    return runPipeline(pipeline, { body }, { modules: [{ module, instance }], steps: EXPOSE_VERIFIED_USER, writes: { "test.exposeVerifiedUser": ["result"] } });
  }

  it("verifyUser:reassignTo writes the canonical name even when the payload names a different one, and null without a target", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const id = boundaryCast<{ id: string }>(created.result, "json").id;

    const named = await verify(verifyUserPipeline, { reassignTo: { id, name: "someone-else" } }, instance);
    expect(named.status).toBe(200);
    expect(named.result).toEqual({ id, name: "carol" });

    const bareId = await verify(verifyUserPipeline, { reassignTo: id }, instance);
    expect(bareId.status).toBe(200);
    expect(bareId.result).toEqual({ id, name: "carol" });

    const noTarget = await verify(verifyUserPipeline, {}, instance);
    expect(noTarget.status).toBe(200);
    expect(noTarget.result).toBeNull();
  });

  it("verifyUser:reassignTo rejects an unknown or inactive target, and a malformed reassignTo", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const id = boundaryCast<{ id: string }>(created.result, "json").id;
    await runPipeline(deactivateUserPipeline, { params: { id } }, { modules: [{ module, instance }] });

    const unknown = await verify(verifyUserPipeline, { reassignTo: "nobody" }, instance);
    expect(unknown).toMatchObject({ status: 404, code: "NOT_FOUND" });

    const inactive = await verify(verifyUserPipeline, { reassignTo: id }, instance);
    expect(inactive).toMatchObject({ status: 400, code: "VALIDATION" });

    const malformed = await verify(verifyUserPipeline, { reassignTo: 7 }, instance);
    expect(malformed).toMatchObject({ status: 400, code: "VALIDATION" });
  });

  it("verifyUser:result.reassignTo reads the shape an authn.deleteUser event hands over, and only that path", async () => {
    const { instance } = await boot();
    const created = await runPipeline(createUserPipeline, { body: { username: "carol", password: "long-enough" } }, { modules: [{ module, instance }] });
    const id = boundaryCast<{ id: string }>(created.result, "json").id;

    const handedOver = await verify(verifyUserEventPipeline, { result: { ok: true, reassignTo: { id, name: "someone-else" } } }, instance);
    expect(handedOver.status).toBe(200);
    expect(handedOver.result).toEqual({ id, name: "carol" });

    const noTarget = await verify(verifyUserEventPipeline, { result: { ok: true, reassignTo: null } }, instance);
    expect(noTarget.status).toBe(200);
    expect(noTarget.result).toBeNull();

    const topLevelIgnored = await verify(verifyUserEventPipeline, { reassignTo: id }, instance);
    expect(topLevelIgnored.status).toBe(200);
    expect(topLevelIgnored.result).toBeNull();
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

describe("authn/multi: atomicSafe is pinned", () => {
  it("matches the shipped table", async () => {
    const { instance } = await boot();
    const describeMap = boundaryCast<Record<string, StepDescription | ((arg: string) => StepDescription)>>(module.describe!(instance), "host");
    const expected: Record<string, boolean> = { verifyUser: true, requireAbsentUser: true, updateUser: true, deactivateUser: true, deleteUser: true, requireUser: false, loadIdentity: false, login: false, logout: false };
    for (const [name, expect_] of Object.entries(expected)) {
      const description = describeMap[name];
      const resolved = typeof description === "function" ? description("x") : description;
      expect(resolved?.atomicSafe === true, `${name}.atomicSafe`).toBe(expect_);
    }
  });
});
