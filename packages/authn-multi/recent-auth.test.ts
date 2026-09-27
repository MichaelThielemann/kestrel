import { describe, expect, it } from "vitest";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isStepFactory } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { createAuthnMulti } from "./impl.ts";
import module from "./module.ts";

const config = { identifier: "username" as const, minPasswordLength: 8, sessionTtlSeconds: 3600, adminPermission: "users.manage" };

const guarded = (name: string, step: string) => definePipeline({ name, steps: ["authn.requireUser", "authn.requireRecentAuth:300", step] });
const login = definePipeline({ name: "login", steps: ["authn.login"] });
const confirm = definePipeline({ name: "confirmPassword", steps: ["authn.requireUser", "authn.confirmPassword"] });
const setPassword = definePipeline({ name: "setPassword", steps: ["authn.requireUser", "authn.setPassword"] });

async function setup() {
  let t = 1_000_000;
  const instance = await createAuthnMulti(config, createFakePersistence(), () => t);
  const admin = expectOk(await instance.createUser({ username: "admin", password: "long-enough", roles: ["admin"] }));
  const other = expectOk(await instance.createUser({ username: "bob", password: "long-enough" }));
  const options = { modules: [{ module, instance }] };
  const loggedIn = await runPipeline(login, { body: { username: "admin", password: "long-enough" } }, options);
  const headers = { authorization: `Bearer ${boundaryCast<{ token: string }>(loggedIn.result, "json").token}` };
  return { instance, admin, other, options, headers, advance: (ms: number) => { t += ms; } };
}

describe("authn/multi recent authentication", () => {
  const cases: Array<{ pipeline: string; step: string; input: (ids: { other: string }) => { body?: Record<string, unknown>; params?: Record<string, string> } }> = [
    { pipeline: "createUser", step: "authn.createUser", input: () => ({ body: { username: `new-${Math.random().toString(36).slice(2)}`, password: "long-enough" } }) },
    { pipeline: "updateUser", step: "authn.updateUser", input: ({ other }) => ({ params: { id: other }, body: { roles: ["editor"] } }) },
    { pipeline: "setPassword", step: "authn.setPassword", input: ({ other }) => ({ params: { id: other }, body: { password: "another-one" } }) },
    { pipeline: "deactivateUser", step: "authn.deactivateUser", input: ({ other }) => ({ params: { id: other } }) },
    { pipeline: "deleteUser", step: "authn.deleteUser", input: ({ other }) => ({ params: { id: other }, body: {} }) },
  ];

  for (const { pipeline, step, input } of cases) {
    it(`${pipeline} answers 403 REAUTH_REQUIRED once the last password check is older than the window, and runs after confirming the password`, async () => {
      const { other, options, headers, advance } = await setup();
      const run = () => runPipeline(guarded(pipeline, step), { headers, ...input({ other: other.id }) }, options);
      advance(301_000);
      const refused = await run();
      expect(refused.status).toBe(403);
      expect(refused.code).toBe("REAUTH_REQUIRED");
      const confirmed = await runPipeline(confirm, { headers, body: { password: "long-enough" } }, options);
      expect(confirmed.status).toBe(200);
      expect((await run()).status).toBe(200);
    });
  }

  it("lets a fresh login through without asking again", async () => {
    const { other, options, headers, advance } = await setup();
    advance(299_000);
    expect((await runPipeline(guarded("deactivateUser", "authn.deactivateUser"), { headers, params: { id: other.id } }, options)).status).toBe(200);
  });

  it("does not refresh the session on a wrong password", async () => {
    const { other, options, headers, advance } = await setup();
    advance(301_000);
    const wrong = await runPipeline(confirm, { headers, body: { password: "not-the-password" } }, options);
    expect(wrong.status).toBe(400);
    expect((await runPipeline(guarded("deactivateUser", "authn.deactivateUser"), { headers, params: { id: other.id } }, options)).code).toBe("REAUTH_REQUIRED");
  });

  it("refuses setPassword on the caller's own account; changing one's own password needs the current one", async () => {
    const { admin, options, headers } = await setup();
    const own = await runPipeline(setPassword, { headers, params: { id: admin.id }, body: { password: "another-one" } }, options);
    expect(own.status).toBe(400);
    expect(own.error).toMatch(/changePassword/);
  });

  it("refuses a window that is not a positive whole number of seconds at boot", async () => {
    const { instance } = await setup();
    const factory = module.steps!(instance).requireRecentAuth;
    if (!isStepFactory(factory)) throw new Error("requireRecentAuth is not a step factory");
    for (const bad of ["0", "-5", "abc", "1.5"]) expect(() => factory(bad), bad).toThrow(/positive whole number of seconds/);
  });
});

describe("authn/multi ending a user's sessions and a second factor's code", () => {
  it("authn.endSessions ends every session of the user in params.id and no one else's", async () => {
    const { instance, admin, other, options, headers } = await setup();
    const others = await runPipeline(login, { body: { username: "bob", password: "long-enough" } }, options);
    const otherHeaders = { authorization: `Bearer ${boundaryCast<{ token: string }>(others.result, "json").token}` };
    const end = definePipeline({ name: "endSessions", steps: ["authn.endSessions"] });
    expect((await runPipeline(end, { params: { id: other.id } }, options)).result).toEqual({ ok: true });
    expect(expectOk(await instance.resolve(otherHeaders.authorization.slice(7)))).toBeNull();
    expect(expectOk(await instance.resolve(headers.authorization.slice(7)))?.id).toBe(admin.id);
  });

  it("login accepts a second factor's code in the body and leaves it to a later step", async () => {
    const { options } = await setup();
    expect((await runPipeline(login, { body: { username: "admin", password: "long-enough", code: "123456" } }, options)).status).toBe(200);
  });
});

describe("authn/multi account names at sign-in", () => {
  it("refuses a username or email longer than 320 characters before it is looked up or repeated", async () => {
    const { options } = await setup();
    for (const field of ["username", "email"]) {
      const run = await runPipeline(login, { body: { [field]: "x".repeat(321), password: "long-enough" } }, options);
      expect(run).toMatchObject({ status: 400, code: "VALIDATION" });
      expect(JSON.stringify(run).length).toBeLessThan(2000);
    }
  });
});
