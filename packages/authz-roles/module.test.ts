import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot as bootKestrel, defineModule } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
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

const setsIdentity = { "identity.set": ["identity?"] };

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
    const res = await runPipeline(requireWritePipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": async (ctx: Context) => ok(ctx) }, writes: setsIdentity });
    expect(res.status).toBe(401);
  });

  it("answers 403 FORBIDDEN when the identity lacks the permission", async () => {
    const instance = await boot();
    const res = await runPipeline(requireWritePipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": withIdentity({ id: "v", claims: { roles: ["visitor"] } }) }, writes: setsIdentity });
    expect(res.status).toBe(403);
    expect(res.code).toBe("FORBIDDEN");
  });

  it("passes when the identity has the permission", async () => {
    const instance = await boot();
    const res = await runPipeline(requireWritePipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": withIdentity({ id: "e", claims: { roles: ["editor"] } }) }, writes: setsIdentity });
    expect(res.status).toBe(200);
  });

  it("describeAccess answers 401 without identity", async () => {
    const instance = await boot();
    const res = await runPipeline(definePipeline({ name: "describeAccess", steps: ["authz.describeAccess"] }), {}, { modules: [{ module, instance }] });
    expect(res.status).toBe(401);
  });

  it("describeAccess outside a booted instance is a wiring error", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "describeAccess", steps: ["identity.set", "authz.describeAccess"] });
    const res = await runPipeline(pipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": withIdentity({ id: "e", claims: { roles: ["editor"] } }) }, writes: setsIdentity });
    expect(res).toMatchObject({ status: 500, code: "INTERNAL" });
  });
});

function identityModule(identity: Identity) {
  return defineModule({
    name: "probe/identity",
    provides: [],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return {};
    },
    steps: () => ({ set: async (ctx: Context) => ok({ ...ctx, identity }) }),
    describe: () => ({ set: { summary: "sets a fixed identity", reads: [], writes: ["identity"] } }),
  });
}

describe("authz/roles: permissions and roles from a booted instance", () => {
  const roles = { chef: ["pages.*"], autor: ["media.read"] };

  async function bootWithUniverse(identity: Identity) {
    const probe = identityModule(identity);
    return bootKestrel({
      config: {
        modules: [
          { use: "./probe.ts", config: {} },
          { use: "@michaelthielemann/kestrel-authz-roles", config: { roles, anonymous: [] } },
        ],
        triggers: [],
        http: null,
      },
      modules: [probe, module],
      pipelines: [
        definePipeline({ name: "readPages", steps: ["authz.require:pages.read"] }),
        definePipeline({ name: "writePages", steps: ["authz.require:pages.write"] }),
        definePipeline({ name: "manageUsers", steps: ["authz.require:users.manage"] }),
        definePipeline({ name: "readMedia", steps: ["authz.require:media.read"] }),
        definePipeline({ name: "me", steps: ["probe.set", "authz.describeAccess"] }),
      ],
      logger: silentLogger,
    });
  }

  it("expands a wildcard role pattern to exactly the matching concrete permissions", async () => {
    const kestrel = await bootWithUniverse({ id: "c", claims: { roles: ["chef"] } });
    const trigger = { kind: "http" as const, name: "test" };
    const res = await kestrel.run("me", { trigger });
    expect(res.result).toMatchObject({ permissions: ["pages.read", "pages.write"] });
    await kestrel.stop();
  });

  it("never surfaces a permission no booted pipeline requires, even under a matching pattern", async () => {
    const kestrel = await bootWithUniverse({ id: "c", claims: { roles: ["chef"] } });
    const trigger = { kind: "http" as const, name: "test" };
    const res = await kestrel.run("me", { trigger });
    const permissions = boundaryCast<{ permissions: string[] }>(res.result, "json").permissions;
    expect(permissions).not.toContain("pages.manage");
    await kestrel.stop();
  });

  it("answers an empty permission list for a caller with no matching role", async () => {
    const kestrel = await bootWithUniverse({ id: "v", claims: { roles: ["visitor"] } });
    const trigger = { kind: "http" as const, name: "test" };
    const res = await kestrel.run("me", { trigger });
    expect(res.result).toMatchObject({ permissions: [] });
    await kestrel.stop();
  });

  it("answers the configured role names in config order, regardless of the caller's own roles", async () => {
    const kestrel = await bootWithUniverse({ id: "a", claims: { roles: ["autor"] } });
    const trigger = { kind: "http" as const, name: "test" };
    const res = await kestrel.run("me", { trigger });
    expect(res.result).toMatchObject({ roles: ["chef", "autor"], permissions: ["media.read"] });
    await kestrel.stop();
  });
});
