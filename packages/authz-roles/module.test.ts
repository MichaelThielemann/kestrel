import { describe, expect, it } from "vitest";
import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Context, Step } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
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
  const config = configSchema.parse({ roles: { admin: ["*"], editor: ["pages.*"] }, anonymous: ["pages.read"] });
  return module.setup(config, deps);
}

function withIdentity(identity: Identity): Step {
  return async (ctx: Context) => ok({ ...ctx, identity });
}

const requireReadPipeline = definePipeline({ name: "requireRead", steps: ["authz.require:pages.read"] });
const requireWritePipeline = definePipeline({ name: "requireWrite", steps: ["identity.set", "authz.require:pages.write"] });

describe("authz/roles module steps via runPipeline", () => {
  it("passes without identity when the permission is anonymous", async () => {
    const instance = await boot();
    const res = await runPipeline(requireReadPipeline, {}, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
  });

  it("answers 401 UNAUTHENTICATED without identity for a non-anonymous permission", async () => {
    const instance = await boot();
    const res = await runPipeline(requireWritePipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": async (ctx: Context) => ok(ctx) } });
    expect(res.status).toBe(401);
  });

  it("answers 403 FORBIDDEN when the identity lacks the permission", async () => {
    const instance = await boot();
    const res = await runPipeline(requireWritePipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": withIdentity({ id: "v", claims: { roles: ["visitor"] } }) } });
    expect(res.status).toBe(403);
    expect(res.code).toBe("FORBIDDEN");
  });

  it("passes when the identity has the permission", async () => {
    const instance = await boot();
    const res = await runPipeline(requireWritePipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": withIdentity({ id: "e", claims: { roles: ["editor"] } }) } });
    expect(res.status).toBe(200);
  });
});
