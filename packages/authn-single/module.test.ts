import { describe, expect, it } from "vitest";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { hashPassword } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const deps: Deps = {
  get<T>(contract: Contract<T>): T {
    throw new Error(`no provider for "${contract.name}"`);
  },
  find: () => undefined,
  logger: silentLogger,
  root: process.cwd(),
};

async function boot() {
  const config = configSchema.parse({ username: "admin", passwordHash: hashPassword("secret"), sessionTtlSeconds: 60, roles: ["admin"] });
  return module.setup(config, deps);
}

function problems(details: Record<string, unknown> | undefined): Array<{ path: string; message: string }> {
  return (details as { problems: Array<{ path: string; message: string }> }).problems;
}

const loginPipeline = definePipeline({ name: "login", steps: ["authn.login"] });
const identifyPipeline = definePipeline({ name: "identify", steps: ["authn.identifyUser"] });
const requirePipeline = definePipeline({ name: "require", steps: ["authn.requireUser"] });
const loadIdentityPipeline = definePipeline({ name: "loadIdentity", steps: ["authn.requireUser", "authn.loadIdentity"] });
const logoutPipeline = definePipeline({ name: "logout", steps: ["authn.requireUser", "authn.logout"] });

describe("authn/single module steps via runPipeline", () => {
  it("login, identifyUser, requireUser, loadIdentity and logout round-trip", async () => {
    const instance = await boot();

    const loggedIn = await runPipeline(loginPipeline, { body: { username: "admin", password: "secret" } }, { modules: [{ module, instance }] });
    expect(loggedIn.status).toBe(200);
    const token = (loggedIn.result as { token: string }).token;
    const headers = { authorization: `Bearer ${token}` };

    const identified = await runPipeline(identifyPipeline, { headers }, { modules: [{ module, instance }] });
    expect(identified.status).toBe(200);

    const required = await runPipeline(requirePipeline, { headers }, { modules: [{ module, instance }] });
    expect(required.status).toBe(200);

    const loaded = await runPipeline(loadIdentityPipeline, { headers }, { modules: [{ module, instance }] });
    expect(loaded.status).toBe(200);
    expect((loaded.result as { id: string }).id).toBe("admin");

    const loggedOut = await runPipeline(logoutPipeline, { headers }, { modules: [{ module, instance }] });
    expect(loggedOut.status).toBe(200);
  });

  it("login answers 401 UNAUTHENTICATED on wrong credentials", async () => {
    const instance = await boot();
    const res = await runPipeline(loginPipeline, { body: { username: "admin", password: "wrong" } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(401);
    expect(res.code).toBe("UNAUTHENTICATED");
  });

  it("requireUser answers 401 UNAUTHENTICATED without a token", async () => {
    const instance = await boot();
    const res = await runPipeline(requirePipeline, {}, { modules: [{ module, instance }] });
    expect(res.status).toBe(401);
  });

  it("login answers 400 VALIDATION when a field has the wrong type", async () => {
    const instance = await boot();
    const res = await runPipeline(loginPipeline, { body: { username: ["a"], password: "x" } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(problems(res.details)[0]?.path).toBe("$.username");
  });

  it("login answers 400 VALIDATION on an unexpected field (additionalProperties: false)", async () => {
    const instance = await boot();
    const res = await runPipeline(loginPipeline, { body: { username: "admin", password: "secret", extra: true } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(problems(res.details)[0]?.path).toBe("$.extra");
  });
});
