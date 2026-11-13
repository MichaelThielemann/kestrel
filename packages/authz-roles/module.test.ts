import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot as bootKestrel, defineModule } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Context, Step } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline, type PipelineDefinition } from "@michaelthielemann/kestrel/definePipeline";
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

describe("authz/roles config: field grants", () => {
  it("defaults both grants to none", () => {
    expect(configSchema.parse({ roles: {} })).toMatchObject({ anonymousFields: {}, fields: {} });
  });

  it("accepts resources and field paths, members, sub-members and list elements", () => {
    const parsed = configSchema.parse({ roles: { editor: [] }, anonymousFields: { media: ["id", "provenance.origin", "variants[].path", "headers.x-content-provenance", "_translations"] }, fields: { editor: { media: ["folder"] } } });
    expect(parsed.fields).toEqual({ editor: { media: ["folder"] } });
  });

  it("refuses a field grant for a role roles does not define", () => {
    const parsed = configSchema.safeParse({ roles: { editor: [] }, fields: { reviewer: { media: ["folder"] } } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual(['fields names role "reviewer", which roles does not define']);
  });

  it("refuses a malformed resource, a malformed path and an empty grant", () => {
    for (const anonymousFields of [{ "1media": ["id"] }, { media: ["variants.[].path"] }, { media: ["a..b"] }, { media: ["a b"] }, { media: [] }]) {
      expect(configSchema.safeParse({ roles: {}, anonymousFields }).success, JSON.stringify(anonymousFields)).toBe(false);
    }
  });
});

const ITEM_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, secret: { type: "string" }, note: { type: "string" }, nested: { type: "object", properties: { open: { type: "string" }, hidden: { type: "string" } }, required: ["open", "hidden"] } },
  required: ["id", "secret", "note", "nested"],
};
const RECORD = { id: "r1", secret: "s3cret", note: "n", nested: { open: "o", hidden: "h" } };

function recordsModule() {
  return defineModule({
    name: "records/test",
    provides: [],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return {};
    },
    steps: () => ({
      get: async (ctx: Context) => ok({ ...ctx, result: RECORD }),
      list: async (ctx: Context) => ok({ ...ctx, result: { items: [RECORD, RECORD], total: 2, cursor: "next" } }),
      stop: async (ctx: Context) => ctx.done(ctx.result),
      bundle: async (ctx: Context) => ok({ ...ctx, result: { id: "b1", secret: "s3cret", items: [{ label: "a", note: "x" }, { label: "b", note: "y" }], total: 2 } }),
      signIn: async (ctx: Context) => {
        const role = ctx.headers["x-role"];
        return ok(role === undefined ? ctx : { ...ctx, identity: { id: "u", claims: { roles: role.split(",") } } });
      },
    }),
    describe: () => ({
      get: { summary: "one record", reads: [], writes: ["result"], output: ITEM_SCHEMA },
      list: { summary: "records", reads: [], writes: ["result"], output: { type: "object", properties: { items: { type: "array", items: ITEM_SCHEMA }, total: { type: "number" }, cursor: { type: "string" } }, required: ["items", "total"] } },
      signIn: { summary: "signs in the x-role header's roles", reads: [], writes: ["identity?"] },
      stop: { summary: "ends the run with the answer so far, declaring no early answer", reads: ["result"], writes: [] },
      bundle: {
        summary: "one record whose items member is a list",
        reads: [],
        writes: ["result"],
        output: { type: "object", properties: { id: { type: "string" }, secret: { type: "string" }, items: { type: "array", items: { type: "object", properties: { label: { type: "string" }, note: { type: "string" } }, required: ["label", "note"] } }, total: { type: "number" } }, required: ["id", "secret", "items", "total"] },
      },
    }),
  });
}

const RECORD_PIPELINES: PipelineDefinition[] = [
  definePipeline({ name: "getRecord", steps: ["records.signIn", "authz.require:records.read", "records.get", "authz.fields:records?shape=item"] }),
  definePipeline({ name: "listRecords", steps: ["records.signIn", "authz.require:records.read", "records.list", "authz.fields:records?shape=list"] }),
];

async function bootRecords(authzConfig: Record<string, unknown>, pipelines: PipelineDefinition[] = RECORD_PIPELINES, validateOutput = true) {
  return bootKestrel({
    config: {
      modules: [{ use: "./records.ts", config: {} }, { use: "@michaelthielemann/kestrel-authz-roles", config: authzConfig }],
      triggers: pipelines.map((p) => ({ http: `GET /${p.name}`, pipeline: p.name })),
      http: null,
    },
    modules: [recordsModule(), module],
    pipelines,
    logger: silentLogger,
    validateOutput,
  });
}

describe("authz/roles: authz.fields cuts the answer to the caller's field grant", () => {
  const grants = { roles: { editor: ["*"], reviewer: ["records.read"], archivist: ["records.read"] }, anonymous: ["records.read"], anonymousFields: { records: ["id", "nested.open"] }, fields: { reviewer: { records: ["note"] }, archivist: { records: ["secret"] } } };
  const as = (role?: string) => ({ trigger, headers: role === undefined ? {} : { "x-role": role } });

  it("answers an anonymous caller only the anonymous grant, item by item in a list", async () => {
    const kestrel = await bootRecords(grants);
    expect(await kestrel.run("getRecord", as())).toMatchObject({ status: 200, result: { id: "r1", nested: { open: "o" } } });
    expect((await kestrel.run("getRecord", as())).result).toEqual({ id: "r1", nested: { open: "o" } });
    expect((await kestrel.run("listRecords", as())).result).toEqual({ items: [{ id: "r1", nested: { open: "o" } }, { id: "r1", nested: { open: "o" } }], total: 2 });
    await kestrel.stop();
  });

  it("answers a role without a field grant the whole answer", async () => {
    const kestrel = await bootRecords(grants);
    expect((await kestrel.run("getRecord", as("editor"))).result).toEqual(RECORD);
    expect((await kestrel.run("getRecord", as("reviewer,editor"))).result).toEqual(RECORD);
    await kestrel.stop();
  });

  it("answers a role with a field grant its grant and the anonymous one, never a member neither grants", async () => {
    const kestrel = await bootRecords(grants);
    expect((await kestrel.run("getRecord", as("reviewer"))).result).toEqual({ id: "r1", note: "n", nested: { open: "o" } });
    expect((await kestrel.run("getRecord", as("reviewer,archivist"))).result).toEqual({ id: "r1", secret: "s3cret", note: "n", nested: { open: "o" } });
    await kestrel.stop();
  });

  it("declares per audience what it keeps, from the config", async () => {
    const kestrel = await bootRecords(grants);
    const step = kestrel.describe().pipelines.find((p) => p.name === "listRecords")?.steps.at(-1);
    expect(step?.description.narrows).toEqual({ shape: "list", answers: { anonymous: ["id", "nested.open"], "role:reviewer": ["note", "id", "nested.open"], "role:archivist": ["secret", "id", "nested.open"] } });
    await kestrel.stop();
  });

  it("answers a signed-in caller without a configured role like an anonymous one, and 403 where anonymous callers have no grant", async () => {
    const kestrel = await bootRecords(grants);
    expect((await kestrel.run("getRecord", as("ghost"))).result).toEqual({ id: "r1", nested: { open: "o" } });
    await kestrel.stop();
    const { anonymousFields: _anonymousFields, ...withoutAnonymousGrant } = grants;
    void _anonymousFields;
    const signedInOnly = [definePipeline({ name: "getRecord", steps: ["records.signIn", "authn.requireUser", "authz.requireRole", "authz.require:records.read", "records.get", "authz.fields:records?shape=item"] })];
    const signedInOnlyKestrel = await bootRecordsSignedIn(withoutAnonymousGrant, signedInOnly);
    const res = await signedInOnlyKestrel.run("getRecord", as("ghost"));
    expect(res).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(JSON.stringify(res)).not.toContain("s3cret");
    expect((await signedInOnlyKestrel.run("getRecord", as("editor"))).result).toEqual(RECORD);
    await signedInOnlyKestrel.stop();
  });

  it("cuts an item whose items member is an array as one item when the step names ?shape=item", async () => {
    const pipelines = [definePipeline({ name: "getRecord", steps: ["records.signIn", "authz.require:records.read", "records.bundle", "authz.fields:records?shape=item"] })];
    const kestrel = await bootRecords({ ...grants, anonymousFields: { records: ["id", "items[].label"] }, fields: {} }, pipelines);
    expect((await kestrel.run("getRecord", as())).result).toEqual({ id: "b1", items: [{ label: "a" }, { label: "b" }] });
    await kestrel.stop();
  });

  it("answers 403 FORBIDDEN to an anonymous caller of a resource without an anonymous grant", async () => {
    const instance = await module.setup(configSchema.parse({ roles: {}, anonymous: ["records.read"] }), deps);
    const pipeline = definePipeline({ name: "getRecord", steps: ["records.get", "authz.fields:records?shape=item"] });
    const mod = recordsModule();
    const res = await runPipeline(pipeline, {}, { modules: [{ module: mod, instance: await mod.setup({}, deps) }, { module, instance }] });
    expect(res).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("never answers an early exit past the step that declares no early answer, even without validateOutput", async () => {
    const pipelines = [definePipeline({ name: "getRecord", steps: ["records.signIn", "authz.require:records.read", "records.get", "records.stop", "authz.fields:records?shape=item"] })];
    const kestrel = await bootRecords(grants, pipelines, false);
    const res = await kestrel.run("getRecord", as());
    expect(res).toMatchObject({ status: 500, code: "INTERNAL", error: "getRecord/records.stop: unexpected Error" });
    expect(JSON.stringify(res)).not.toContain("s3cret");
    await kestrel.stop();
  });

  it("fails boot for a list copied with ?shape=item whose granted fields exist only on its elements", async () => {
    const pipelines = [RECORD_PIPELINES[0]!, definePipeline({ name: "listRecords", steps: ["records.signIn", "authz.require:records.read", "records.list", "authz.fields:records?shape=item"] })];
    await expect(bootRecords({ ...grants, anonymousFields: { records: ["id", "nested.open", "items"] }, fields: {} }, pipelines)).rejects.toThrow(
      'authz/roles: pipeline "listRecords" ends with authz.fields:records?shape=item, but its declared output reads as a list ({ items, total }) and anonymousFields.records names "id", which only its items declare – write authz.fields:records?shape=list',
    );
  });

  it("fails boot with its own message for a resource name that is not a name, in anonymousFields and in fields", async () => {
    await expect(bootRecords({ roles: { admin: ["*"] }, anonymousFields: { "Bad Name": ["id"] } })).rejects.toThrow('invalid config: anonymousFields.Bad Name: a resource is a name such as "media"');
    await expect(bootRecords({ roles: { admin: ["*"] }, fields: { admin: { "Bad Name": ["id"] } } })).rejects.toThrow('invalid config: fields.admin.Bad Name: a resource is a name such as "media"');
  });

  it("fails boot for a step argument without a resource and a shape", async () => {
    await expect(bootRecords(grants, [definePipeline({ name: "getRecord", steps: ["records.get", "authz.fields:records"] })])).rejects.toThrow('authz.fields:records – write authz.fields:<resource>?shape=<item|list|array|file>, e.g. authz.fields:media?shape=list');
  });

  it("fails boot when an anonymously answered pipeline does not end with the step", async () => {
    await expect(bootRecords(grants, [definePipeline({ name: "getRecord", steps: ["records.signIn", "authz.require:records.read", "records.get"] }), definePipeline({ name: "listRecords", steps: ["records.list", "authz.fields:records?shape=list"] })])).rejects.toThrow('authz/roles: pipeline "getRecord" answers anonymous callers but does not end with authz.fields:<resource>?shape=item');
  });
});

function requireUserModule() {
  return defineModule({
    name: "authn/stub",
    provides: [],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return {};
    },
    steps: () => ({ requireUser: async (ctx: Context) => (ctx.identity ? ok(ctx) : ctx.fail("UNAUTHENTICATED", "not authenticated")) }),
    describe: () => ({ requireUser: { summary: "requires a signed-in caller", reads: ["identity?"], writes: [], security: "required" as const } }),
  });
}

async function bootRecordsSignedIn(authzConfig: Record<string, unknown>, pipelines: PipelineDefinition[]) {
  return bootKestrel({
    config: {
      modules: [{ use: "./records.ts", config: {} }, { use: "./authn.ts", config: {} }, { use: "@michaelthielemann/kestrel-authz-roles", config: authzConfig }],
      triggers: pipelines.map((p) => ({ http: `GET /${p.name}`, pipeline: p.name })),
      http: null,
    },
    modules: [recordsModule(), requireUserModule(), module],
    pipelines,
    logger: silentLogger,
    validateOutput: true,
  });
}
