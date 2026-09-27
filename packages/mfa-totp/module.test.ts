import { describe, expect, it } from "vitest";
import { AUTHN } from "@michaelthielemann/kestrel-contracts/authn";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createAuthnFake, fakeAuthnSteps, FAKE_AUTHN_WRITES } from "@michaelthielemann/kestrel-contracts/testing/fakeAuthn";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { base32Decode, totp } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function boot(enforce: "all" | "none" = "all") {
  const authn = createAuthnFake("alice", "long-enough");
  const logout = authn.logout.bind(authn);
  let loggedOut = 0;
  authn.logout = async (token) => {
    loggedOut += 1;
    return logout(token);
  };
  const providers = new Map<string, unknown>([[PERSISTENCE.name, createFakePersistence()], [AUTHN.name, authn]]);
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: () => undefined,
    logger: silentLogger,
    root: process.cwd(),
    eventTriggers: [],
  };
  const instance = await module.setup(configSchema.parse({ issuer: "Example CMS", secretKey: KEY, enforce }), deps);
  const options = { modules: [{ module, instance }], steps: fakeAuthnSteps(authn), writes: FAKE_AUTHN_WRITES };
  return { authn, options, loggedOut: () => loggedOut };
}

const login = definePipeline({ name: "login", steps: ["authn.login", "mfa.check"] });
const setup = definePipeline({ name: "setupSecondFactor", steps: ["mfa.startSetup"] });
const reset = definePipeline({ name: "resetSecondFactor", steps: ["authn.requireUser", "mfa.reset"] });
const listEnrolled = definePipeline({ name: "secondFactorUsers", steps: ["mfa.listEnrolled"] });
const forget = definePipeline({ name: "forgetSecondFactor", steps: ["mfa.forget"] });

const tokenOf = (result: unknown) => boundaryCast<{ token: string }>(result, "json").token;

describe("mfa/totp steps", () => {
  it("refuses a sign-in that still needs a factor with its own code, ends the session the password opened, and sends no cookie", async () => {
    const { options, loggedOut } = await boot();
    const refused = await runPipeline(login, { body: { username: "alice", password: "long-enough" } }, options);
    expect(refused).toMatchObject({ status: 401, code: "SECOND_FACTOR_SETUP_REQUIRED", details: { username: "alice" } });
    expect(refused.headers).toBeUndefined();
    expect(loggedOut()).toBe(1);
  });

  it("sets a factor up, confirms it with the login, answers the recovery codes once, and then wants a code every time", async () => {
    const { authn, options } = await boot();
    const started = await runPipeline(setup, { body: { username: "alice", password: "long-enough" } }, options);
    expect(started.status).toBe(200);
    const { secret, uri } = boundaryCast<{ secret: string; uri: string }>(started.result, "json");
    expect(uri).toContain(`secret=${secret}`);
    expect((await runPipeline(setup, { body: { username: "alice", password: "wrong-password" } }, options))).toMatchObject({ status: 401, details: { username: "alice" } });

    const code = totp(base32Decode(secret), Math.floor(Date.now() / 30_000));
    const confirmed = await runPipeline(login, { body: { username: "alice", password: "long-enough", code } }, options);
    expect(confirmed.status).toBe(200);
    expect(boundaryCast<{ recoveryCodes: string[] }>(confirmed.result, "json").recoveryCodes).toHaveLength(10);
    expect(confirmed.headers?.["set-cookie"]).toMatch(/^kestrel_token=/);
    expect((await authn.resolve(tokenOf(confirmed.result))).ok).toBe(true);

    const needsCode = await runPipeline(login, { body: { username: "alice", password: "long-enough" } }, options);
    expect(needsCode).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    const replayed = await runPipeline(login, { body: { username: "alice", password: "long-enough", code } }, options);
    expect(replayed).toMatchObject({ status: 401, code: "UNAUTHENTICATED", details: { username: "alice" } });
    expect((await runPipeline(setup, { body: { username: "alice", password: "long-enough" } }, options)).status).toBe(409);

    expect((await runPipeline(listEnrolled, {}, options)).result).toEqual(["alice"]);

    expect((await runPipeline(forget, { body: { id: "alice" } }, options)).status).toBe(200);
    expect((await runPipeline(login, { body: { username: "alice", password: "long-enough" } }, options)).code).toBe("SECOND_FACTOR_SETUP_REQUIRED");
  });

  it("resets another account's factor, but not the caller's own", async () => {
    const { options } = await boot("none");
    const signedIn = await runPipeline(login, { body: { username: "alice", password: "long-enough" } }, options);
    const headers = { authorization: `Bearer ${tokenOf(signedIn.result)}` };
    expect((await runPipeline(reset, { headers, params: { id: "alice" } }, options)).status).toBe(400);
    expect((await runPipeline(reset, { headers, params: { id: "bob" } }, options)).status).toBe(200);
  });
});

describe("mfa/totp at boot", () => {
  it("boots behind authn-multi and authz-roles, with a routed setup and a reset that ends the user's sessions", async () => {
    const { boot: bootKestrel } = await import("@michaelthielemann/kestrel");
    const persistence = (await import("@michaelthielemann/kestrel-persistence-sqlite")).default;
    const authnMulti = (await import("@michaelthielemann/kestrel-authn-multi")).default;
    const authzRoles = (await import("@michaelthielemann/kestrel-authz-roles")).default;
    const kestrel = await bootKestrel({
      config: {
        modules: [
          { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: ":memory:" } },
          { use: "@michaelthielemann/kestrel-authn-multi", config: {} },
          { use: "@michaelthielemann/kestrel-authz-roles", config: { roles: { admin: ["*"] }, rolelessPipelines: ["reset"] } },
          { use: "@michaelthielemann/kestrel-mfa-totp", config: { secretKey: KEY } },
        ],
        triggers: [{ http: "POST /login", pipeline: "login" }, { http: "POST /login/second-factor", pipeline: "setup" }, { http: "DELETE /users/:id/second-factor", pipeline: "reset" }],
        http: null,
      },
      modules: [persistence, authnMulti, authzRoles, module],
      pipelines: [
        definePipeline({ name: "login", steps: ["authn.login", "mfa.check"] }),
        definePipeline({ name: "setup", steps: ["mfa.startSetup"] }),
        definePipeline({ name: "reset", steps: ["authn.requireUser", "mfa.reset", "authn.endSessions"] }),
      ],
      logger: silentLogger,
    });
    const refused = await kestrel.run("login", { trigger: { kind: "http", name: "POST /login" }, body: { username: "nobody", password: "whatever-it-is" } });
    expect(refused.status).toBe(401);
    await kestrel.stop();
  });
});
