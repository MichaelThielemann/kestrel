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
  eventTriggers: [],
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

  it("passes a signed-in caller whose roles lack a permission that anonymous callers have", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "requireReadSignedIn", steps: ["identity.set", "authz.require:pages.read"] });
    const res = await runPipeline(pipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": withIdentity({ id: "v", claims: { roles: ["visitor"] } }) }, writes: setsIdentity });
    expect(res.status).toBe(200);
  });

  it("passes when the identity has the permission", async () => {
    const instance = await boot();
    const res = await runPipeline(requireWritePipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": withIdentity({ id: "e", claims: { roles: ["editor"] } }) }, writes: setsIdentity });
    expect(res.status).toBe(200);
  });

  it("is a wiring error outside a booted instance", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "describePipelineAccess", steps: ["identity.set", "authz.describePipelineAccess"] });
    const res = await runPipeline(pipeline, {}, { modules: [{ module, instance }], steps: { "identity.set": withIdentity({ id: "e", claims: { roles: ["editor"] } }) }, writes: setsIdentity });
    expect(res).toMatchObject({ status: 500, code: "INTERNAL" });
  });

  it("listRoles answers the configured role names, in config order", async () => {
    const instance = await module.setup(configSchema.parse({ roles: { chef: ["pages.*"], autor: ["media.read"] } }), deps);
    const res = await runPipeline(definePipeline({ name: "listRoles", steps: ["authz.listRoles"] }), {}, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ roles: ["chef", "autor"] });
  });

  it("is a wiring error after a step replaced ctx.result with a non-object", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "badResult", steps: ["identity.set", "authz.describePipelineAccess"] });
    const res = await runPipeline(pipeline, {}, {
      modules: [{ module, instance }],
      steps: { "identity.set": async (ctx: Context) => ok({ ...ctx, identity: { id: "e", claims: { roles: ["editor"] } }, result: "not an object" }) },
      writes: { "identity.set": ["identity?", "result"] },
    });
    expect(res).toMatchObject({ status: 500, code: "INTERNAL" });
  });

  it("listRoles fails with a wiring error when a prior step replaced ctx.result with a non-object", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "badResult", steps: ["set.result", "authz.listRoles"] });
    const res = await runPipeline(pipeline, {}, {
      modules: [{ module, instance }],
      steps: { "set.result": async (ctx: Context) => ok({ ...ctx, result: 42 }) },
      writes: { "set.result": ["result"] },
    });
    expect(res).toMatchObject({ status: 500, code: "INTERNAL" });
  });
});

describe("authz/roles module: validateRoles via runPipeline", () => {
  const rolesPipeline = definePipeline({ name: "rolesPipeline", steps: ["authz.validateRoles:roles"] });

  it("passes when the payload has no roles", async () => {
    const instance = await boot();
    const res = await runPipeline(rolesPipeline, {}, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
  });

  it("passes when every role is configured", async () => {
    const instance = await boot();
    const res = await runPipeline(rolesPipeline, { payload: { roles: ["admin", "editor"] } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
  });

  it("answers 400 VALIDATION with the unknown names when a role is not configured", async () => {
    const instance = await boot();
    const res = await runPipeline(rolesPipeline, { payload: { roles: ["editor", "typo-role"] } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(res.details).toEqual({ unknown: ["typo-role"] });
  });

  it("answers 400 VALIDATION, never 500, when the value is not an array of strings", async () => {
    const instance = await boot();
    const res = await runPipeline(rolesPipeline, { payload: { roles: "admin" } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
  });

  it("reports prototype-key role names as unknown instead of finding an inherited value", async () => {
    const instance = await boot();
    const res = await runPipeline(rolesPipeline, { payload: { roles: ["constructor", "__proto__", "toString"] } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(400);
    expect(res.details).toEqual({ unknown: ["constructor", "__proto__", "toString"] });
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

const customGateModule = defineModule({
  name: "custom/gate",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({ gate: async (ctx: Context) => ok(ctx) }),
  describe: () => ({ gate: { summary: "a gate authz/roles knows nothing about", reads: [], writes: [] } }),
});

const ROLES = { chef: ["*"], autor: ["pages.*"] };
const trigger = { kind: "http" as const, name: "test" };

async function bootWithGatedPipelines(identity: Identity, anonymous: string[] = []) {
  const probe = identityModule(identity);
  return bootKestrel({
    config: {
      modules: [
        { use: "./probe.ts", config: {} },
        { use: "./custom.ts", config: {} },
        { use: "@michaelthielemann/kestrel-authz-roles", config: { roles: ROLES, anonymous } },
      ],
      triggers: [],
      http: null,
    },
    modules: [probe, customGateModule, module],
    pipelines: [
      definePipeline({ name: "gated", steps: ["probe.set", "authz.require:pages.manage"] }),
      definePipeline({ name: "mixed", steps: ["probe.set", "authz.require:pages.write", "authz.require:users.manage"] }),
      definePipeline({ name: "open", steps: ["probe.set", "custom.gate"] }),
      definePipeline({ name: "access", steps: ["probe.set", "authz.describePipelineAccess"] }),
    ],
    logger: silentLogger,
  });
}

describe("authz/roles: describePipelineAccess against a booted instance", () => {
  it("answers granted exactly for the pipelines the same caller can run past their authz.require steps", async () => {
    for (const role of Object.keys(ROLES)) {
      const kestrel = await bootWithGatedPipelines({ id: role, claims: { roles: [role] } });
      const access = await kestrel.run("access", { trigger });
      const pipelineAccess = boundaryCast<{ pipelineAccess: Record<string, string> }>(access.result, "json").pipelineAccess;
      for (const name of ["gated", "mixed"]) {
        const res = await kestrel.run(name, { trigger });
        expect(pipelineAccess[name] === "granted").toBe(res.status === 200);
        expect(pipelineAccess[name] === "denied").toBe(res.status === 403);
      }
      await kestrel.stop();
    }
  });

  it("denies a pipeline when one of its authz.require steps fails", async () => {
    const kestrel = await bootWithGatedPipelines({ id: "a", claims: { roles: ["autor"] } });
    const access = await kestrel.run("access", { trigger });
    const pipelineAccess = boundaryCast<{ pipelineAccess: Record<string, string> }>(access.result, "json").pipelineAccess;
    expect(pipelineAccess.mixed).toBe("denied");
    await kestrel.stop();
  });

  it("answers granted for a signed-in caller when anonymous callers have the permission its roles lack", async () => {
    const kestrel = await bootWithGatedPipelines({ id: "g", claims: { roles: [] } }, ["pages.manage"]);
    const access = await kestrel.run("access", { trigger });
    const pipelineAccess = boundaryCast<{ pipelineAccess: Record<string, string> }>(access.result, "json").pipelineAccess;
    expect(pipelineAccess.gated).toBe("granted");
    expect((await kestrel.run("gated", { trigger })).status).toBe(200);
    await kestrel.stop();
  });

  it("answers unknown for a pipeline without an authz.require step", async () => {
    const kestrel = await bootWithGatedPipelines({ id: "c", claims: { roles: ["chef"] } });
    const access = await kestrel.run("access", { trigger });
    const pipelineAccess = boundaryCast<{ pipelineAccess: Record<string, string> }>(access.result, "json").pipelineAccess;
    expect(pipelineAccess.open).toBe("unknown");
    await kestrel.stop();
  });
});

describe("authz/roles: describePipelineAccess without an identity", () => {
  it("answers the anonymous view when the context has no identity", async () => {
    const kestrel = await bootKestrel({
      config: {
        modules: [{ use: "@michaelthielemann/kestrel-authz-roles", config: { roles: {}, anonymous: ["pages.read"] } }],
        triggers: [],
        http: null,
      },
      modules: [module],
      pipelines: [
        definePipeline({ name: "readPages", steps: ["authz.require:pages.read"] }),
        definePipeline({ name: "writePages", steps: ["authz.require:pages.write"] }),
        definePipeline({ name: "access", steps: ["authz.describePipelineAccess"] }),
      ],
      logger: silentLogger,
    });
    const access = await kestrel.run("access", { trigger });
    const pipelineAccess = boundaryCast<{ pipelineAccess: Record<string, string> }>(access.result, "json").pipelineAccess;
    const readRes = await kestrel.run("readPages", { trigger });
    const writeRes = await kestrel.run("writePages", { trigger });
    expect(pipelineAccess.readPages).toBe("granted");
    expect(readRes.status).toBe(200);
    expect(pipelineAccess.writePages).toBe("denied");
    expect(writeRes.status).toBe(401);
    await kestrel.stop();
  });
});

describe("authz/roles: dataflow and step registration", () => {
  it("boots in a pipeline without an authn step", async () => {
    const kestrel = await bootKestrel({
      config: {
        modules: [{ use: "@michaelthielemann/kestrel-authz-roles", config: { roles: {}, anonymous: [] } }],
        triggers: [],
        http: null,
      },
      modules: [module],
      pipelines: [definePipeline({ name: "access", steps: ["authz.describePipelineAccess"] })],
      logger: silentLogger,
    });
    const res = await kestrel.run("access", { trigger });
    expect(res.status).toBe(200);
    await kestrel.stop();
  });

  it("does not register a describeAccess step", async () => {
    await expect(
      bootKestrel({
        config: {
          modules: [{ use: "@michaelthielemann/kestrel-authz-roles", config: { roles: {}, anonymous: [] } }],
          triggers: [],
          http: null,
        },
        modules: [module],
        pipelines: [definePipeline({ name: "legacy", steps: ["authz.describeAccess"] })],
        logger: silentLogger,
      }),
    ).rejects.toThrow(/unknown step "authz.describeAccess"/);
  });
});
