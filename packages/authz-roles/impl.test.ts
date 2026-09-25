import { describe, it, expect } from "vitest";
import type { Manifest, PipelineManifest } from "@michaelthielemann/kestrel";
import { authzContractTests } from "@michaelthielemann/kestrel-contracts/authz.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { anonymousCan, anonymousPipelines, answersOf, assertAnonymousAccess, createAuthzRoles, fieldGrantProblems, fieldSet, matches, requiredPermissions, type Config } from "./impl.ts";
import module from "./module.ts";

const config = { roles: { admin: ["*"], editor: ["pages.*", "media.read"] }, roleClaim: "roles", anonymous: ["pages.read"] };

authzContractTests(async () => ({
  authz: createAuthzRoles(config),
  allowed: { id: "e", claims: { roles: ["editor"] } },
  denied: { id: "v", claims: { roles: ["visitor"] } },
  permission: "pages.write",
}));

describe("authz/roles", () => {
  it("matches exact, wildcard and prefix permissions", () => {
    expect(matches("*", "anything.at.all")).toBe(true);
    expect(matches("pages.write", "pages.write")).toBe(true);
    expect(matches("pages.*", "pages.write")).toBe(true);
    expect(matches("pages.*", "pagesx.write")).toBe(false);
    expect(matches("pages.write", "pages.read")).toBe(false);
  });

  it("anonymous permissions come from config", () => {
    expect(anonymousCan(config, "pages.read")).toBe(true);
    expect(anonymousCan(config, "pages.write")).toBe(false);
    expect(anonymousCan({ ...config, anonymous: [] }, "pages.read")).toBe(false);
  });

  it("accepts a single role as string and ignores unknown roles", async () => {
    const authz = createAuthzRoles(config);
    expect(expectOk(await authz.can({ id: "a", claims: { roles: "admin" } }, "media.delete"))).toBe(true);
    expect(expectOk(await authz.can({ id: "b", claims: { roles: ["ghost"] } }, "pages.write"))).toBe(false);
    expect(expectOk(await authz.can({ id: "c", claims: {} }, "pages.write"))).toBe(false);
  });

  it("grants every signed-in caller what anonymous callers may do, whatever their roles", async () => {
    const authz = createAuthzRoles(config);
    expect(expectOk(await authz.can({ id: "b", claims: { roles: ["ghost"] } }, "pages.read"))).toBe(true);
    expect(expectOk(await authz.can({ id: "c", claims: {} }, "pages.read"))).toBe(true);
    expect(expectOk(await authz.can({ id: "c", claims: {} }, "pages.write"))).toBe(false);
    expect(expectOk(await createAuthzRoles({ ...config, anonymous: [] }).can({ id: "c", claims: {} }, "pages.read"))).toBe(false);
  });

  it("two boots keep their own anonymous config; the first instance is unaffected by a later boot", async () => {
    const deps: Deps = { get: () => { throw new Error("not needed"); }, find: () => undefined, logger: { step() {}, info() {}, error() {} }, root: process.cwd(), eventTriggers: [] };
    const first = await module.setup(module.configSchema.parse({ roles: {}, anonymous: ["pages.read"] }), deps);
    await module.setup(module.configSchema.parse({ roles: {}, anonymous: [] }), deps);
    const require = (module.steps!(first).require as (permission: string) => (ctx: ReturnType<typeof createContext>) => Promise<unknown>)("pages.read");
    await expect(require(createContext({ trigger: { kind: "http", name: "t" } }))).resolves.toBeDefined();
  });
});

function step(spec: string, atomic?: number): PipelineManifest["steps"][number] {
  const name = spec.split(":")[0] ?? spec;
  return { spec, name, module: "authz", description: { summary: "", reads: [], writes: [] }, ...(atomic === undefined ? {} : { atomic }) };
}

function manifestOf(specs: string[]): Manifest {
  return {
    core: { version: "0.0.0" },
    contracts: [],
    modules: [],
    steps: [],
    pipelines: [{ name: "p", steps: specs.map((spec) => step(spec)) }],
    triggers: { http: [], events: [], crons: [] },
    warnings: [],
  };
}

function pipelineWith(name: string, steps: Array<{ spec: string; description?: Partial<PipelineManifest["steps"][number]["description"]> }>): PipelineManifest {
  return { name, steps: steps.map(({ spec, description }) => ({ ...step(spec), description: { summary: "", reads: [], writes: [], ...description } })) };
}

function manifestWith(pipelines: PipelineManifest[]): Manifest {
  return { core: { version: "0.0.0" }, contracts: [], modules: [], steps: [], pipelines, triggers: { http: [], events: [], crons: [] }, warnings: [] };
}

describe("assertAnonymousAccess", () => {
  const anonymous = { roles: {}, roleClaim: "roles", anonymous: ["media.read"] };

  it("throws when anonymous callers lack a required permission", () => {
    const manifest = manifestWith([pipelineWith("serveMediaFile", [{ spec: "authz.require:pages.read", description: {} }, { spec: "media.serve", description: { anonymous: "required" } }])]);
    expect(() => assertAnonymousAccess(anonymous, manifest)).toThrow(/pipeline "serveMediaFile" runs media.serve.*anonymous callers lack "pages.read"/);
  });

  it("throws when anonymous is empty", () => {
    const manifest = manifestWith([pipelineWith("serveMediaFile", [{ spec: "authz.require:media.read", description: {} }, { spec: "media.serve", description: { anonymous: "required" } }])]);
    expect(() => assertAnonymousAccess({ ...anonymous, anonymous: [] }, manifest)).toThrow(/anonymous callers lack "media.read"/);
  });

  it("throws when an authn step other than authz.require requires a signed-in caller", () => {
    const manifest = manifestWith([pipelineWith("serveMediaFile", [{ spec: "authn.requireUser", description: { security: "required" } }, { spec: "media.serve", description: { anonymous: "required" } }])]);
    expect(() => assertAnonymousAccess(anonymous, manifest)).toThrow(/pipeline "serveMediaFile" runs media.serve.*authn.requireUser requires a signed-in caller/);
  });

  it("passes with an exact, wildcard-scoped or full-wildcard grant", () => {
    for (const grant of ["media.read", "media.*", "*"]) {
      const manifest = manifestWith([pipelineWith("serveMediaFile", [{ spec: "authz.require:media.read", description: {} }, { spec: "media.serve", description: { anonymous: "required" } }])]);
      expect(() => assertAnonymousAccess({ ...anonymous, anonymous: [grant] }, manifest)).not.toThrow();
    }
  });

  it("throws for a pipeline without authz.require, whatever anonymous grants, since there is no permission to check", () => {
    const openManifest = manifestWith([pipelineWith("serveMediaFile", [{ spec: "media.serve", description: { anonymous: "required" } }])]);
    for (const grants of [[], ["media.read"], ["*"]]) {
      expect(() => assertAnonymousAccess({ ...anonymous, anonymous: grants }, openManifest)).toThrow('authz/roles: pipeline "serveMediaFile" runs media.serve, whose output is also published without an access check, but has no authz.require step – gate it with authz.require:<permission> so that boot can check anonymous callers hold that permission');
    }
  });

  it("leaves a pipeline without an anonymous: \"required\" step unaffected, even if it fully requires sign-in", () => {
    const manifest = manifestWith([pipelineWith("adminOnly", [{ spec: "authn.requireUser", description: { security: "required" } }, { spec: "media.serve", description: {} }])]);
    expect(() => assertAnonymousAccess({ ...anonymous, anonymous: [] }, manifest)).not.toThrow();
  });
});

describe("requiredPermissions", () => {
  it("collects each authz.require permission of a pipeline once, in step order, including steps in an atomic group", () => {
    const pipeline: PipelineManifest = {
      name: "p",
      steps: [step("authz.require:a.b"), step("authn.requireUser"), step("authz.require:a.b"), step("authz.require:c.d", 1)],
    };
    expect(requiredPermissions(pipeline)).toEqual(["a.b", "c.d"]);
  });
});

describe("authz/roles: listRoles", () => {
  it("listRoles answers the configured role names in config order", () => {
    const authz = createAuthzRoles({ roles: { chef: ["pages.*"], autor: ["media.read"] }, roleClaim: "roles", anonymous: [] });
    expect(authz.listRoles()).toEqual(["chef", "autor"]);
  });
});

const DANGEROUS_ROLE_NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

describe("authz/roles: a role name shaped like an Object.prototype key never yields an inherited value", () => {
  const dangerousConfig = { roles: { editor: ["pages.*"] }, roleClaim: "roles", anonymous: [] };

  it.each(DANGEROUS_ROLE_NAMES)("authz.can answers false, never throws, for role %s", async (role) => {
    const authz = createAuthzRoles(dangerousConfig);
    await expect(authz.can({ id: "x", claims: { roles: [role] } }, "pages.write")).resolves.toEqual({ ok: true, value: false });
  });

  it.each(DANGEROUS_ROLE_NAMES)("answers denied, never throws, for a role named %s", (role) => {
    const authz = createAuthzRoles(dangerousConfig);
    const detach = authz.attach({ describe: () => manifestOf(["authz.require:pages.read", "authz.require:pages.write"]), observe: () => () => {}, health: () => ({ ok: true, restartRequired: false, modules: [] }) });
    expect(authz.describePipelineAccess({ id: "x", claims: { roles: [role] } })).toEqual({ p: "denied" });
    detach();
  });

  it.each(DANGEROUS_ROLE_NAMES)("module.ts's require step answers 403 FORBIDDEN, never 500, for role %s", async (role) => {
    const authz = createAuthzRoles(dangerousConfig);
    const require = module.steps!(authz).require("pages.write");
    const error = expectErr(await require(withIdentity({ id: "x", claims: { roles: [role] } })), "FORBIDDEN");
    expect(error.status).toBe(403);
  });
});

const ctx = () => createContext({ trigger: { kind: "http", name: "t" } });
const withIdentity = (identity: { id: string; claims: Record<string, unknown> }) => ({ ...ctx(), identity });

describe("authz/roles steps", () => {
  const authz = createAuthzRoles(config);
  const require = (permission: string) => module.steps!(authz).require(permission);

  it("answers UNAUTHENTICATED without identity when canAnonymous is off", async () => {
    const error = expectErr(await require("pages.write")(ctx()), "UNAUTHENTICATED");
    expect(error.status).toBe(401);
  });

  it("passes without identity when canAnonymous grants the permission", async () => {
    expectOk(await require("pages.read")(ctx()));
  });

  it("answers FORBIDDEN when the identity lacks the permission", async () => {
    const error = expectErr(await require("pages.write")(withIdentity({ id: "v", claims: { roles: ["visitor"] } })), "FORBIDDEN");
    expect(error.status).toBe(403);
  });

  it("passes when the identity has the permission", async () => {
    expectOk(await require("pages.write")(withIdentity({ id: "e", claims: { roles: ["editor"] } })));
  });
});

describe("fieldSet", () => {
  const grants: Config = {
    roles: { admin: ["*"], editor: ["pages.*"], reviewer: ["media.read"], translator: ["pages.read"] },
    roleClaim: "roles",
    anonymous: ["media.read"],
    anonymousFields: { media: ["id", "path"] },
    fields: { reviewer: { media: ["folder"] }, translator: { media: ["alt"], pages: ["title"] } },
  };
  const as = (...roles: string[]) => ({ id: "u", claims: { roles } });

  it("gives an anonymous caller the anonymous grant, and nothing for a resource without one", () => {
    expect(fieldSet(grants, undefined, "media")).toEqual(["id", "path"]);
    expect(fieldSet(grants, undefined, "pages")).toBeUndefined();
  });

  it("gives everything to a caller one of whose roles has no field grant for the resource", () => {
    expect(fieldSet(grants, as("editor"), "media")).toBe("all");
    expect(fieldSet(grants, as("reviewer", "admin"), "media")).toBe("all");
    expect(fieldSet(grants, as("reviewer"), "pages")).toBe("all");
  });

  it("gives the union of every role's grant and the anonymous one when every role has a grant", () => {
    expect(fieldSet(grants, as("reviewer"), "media")).toEqual(["folder", "id", "path"]);
    expect(fieldSet(grants, as("reviewer", "translator"), "media")).toEqual(["folder", "alt", "id", "path"]);
    expect(fieldSet(grants, as("translator"), "pages")).toEqual(["title"]);
  });

  it("ignores role names the config does not define", () => {
    expect(fieldSet(grants, as("reviewer", "ghost", "constructor", "__proto__"), "media")).toEqual(["folder", "id", "path"]);
  });

  it("gives an identity without a configured role the anonymous grant, or everything where there is none", () => {
    expect(fieldSet(grants, as(), "media")).toEqual(["id", "path"]);
    expect(fieldSet(grants, as("ghost"), "media")).toEqual(["id", "path"]);
    expect(fieldSet(grants, as("ghost"), "pages")).toBe("all");
  });

  it("names every restricted answer per audience label for the step's declaration", () => {
    expect(answersOf(grants, "media")).toEqual({ anonymous: ["id", "path"], "role:reviewer": ["folder", "id", "path"], "role:translator": ["alt", "id", "path"] });
    expect(answersOf(grants, "pages")).toEqual({ "role:translator": ["title"] });
    expect(answersOf(grants, "settings")).toEqual({});
  });
});

function described(spec: string, description: Partial<PipelineManifest["steps"][number]["description"]> = {}): PipelineManifest["steps"][number] {
  const colon = spec.indexOf(":");
  const name = colon === -1 ? spec : spec.slice(0, colon);
  return { spec, name, module: name.split(".")[0] ?? "", description: { summary: "", reads: [], writes: [], ...description } };
}

const MEDIA_ITEM = {
  type: "object",
  properties: { id: { type: "string" }, folder: { type: "string" }, variants: { type: "array", items: { type: "object", properties: { path: { type: "string" }, bytes: { type: "number" } }, required: ["path", "bytes"] } } },
  required: ["id", "folder", "variants"],
  additionalProperties: false,
};
const MEDIA_LIST = { type: "object", properties: { items: { type: "array", items: MEDIA_ITEM }, total: { type: "number" } }, required: ["items", "total"] };
const REDIRECT_HIT = { type: "object", properties: { redirect: { type: "object", properties: { to: { type: "string" } }, required: ["to"], additionalProperties: false } }, required: ["redirect"], additionalProperties: false };
const identify = described("authn.identifyUser", { writes: ["token?", "identity?"], security: "optional" });
const gate = (permission: string) => described(`authz.require:${permission}`, { security: "required" });
const fields = (arg: string) => described(`authz.fields:${arg}`, { reads: ["identity?", "result?"], writes: ["result?"] });
const getMedia = described("media.get", { writes: ["result"], output: MEDIA_ITEM });
const listMedia = described("media.list", { writes: ["result"], output: MEDIA_LIST });
const serve = described("media.serve", { writes: ["result"], binary: true });
const lookup = described("redirects.lookup", { writes: ["result?"], terminalOutput: REDIRECT_HIT });

function fieldManifest(pipelines: Array<[string, Array<PipelineManifest["steps"][number]>]>, http = pipelines.map(([name]) => name)): Manifest {
  return {
    core: { version: "0.0.0" },
    contracts: [],
    modules: [],
    steps: [],
    pipelines: pipelines.map(([name, steps]) => ({ name, steps })),
    triggers: { http: http.map((pipeline) => ({ method: "GET", path: `/${pipeline}`, pipeline })), events: [], crons: [] },
    warnings: [],
  };
}

describe("anonymousPipelines", () => {
  const config: Config = { roles: {}, roleClaim: "roles", anonymous: ["media.read"] };

  it("lists the HTTP pipelines an anonymous caller reaches and whose answer goes to that caller", () => {
    const manifest = fieldManifest(
      [
        ["getMedia", [identify, gate("media.read"), getMedia]],
        ["open", [getMedia]],
        ["signedIn", [described("authn.requireUser", { writes: ["identity"], security: "required" }), getMedia]],
        ["ungranted", [identify, gate("media.write"), getMedia]],
        ["login", [described("authn.login", { writes: ["token", "identity", "result"] }), described("events.relay", { writes: ["result._events"] })]],
        ["noAnswer", [identify, gate("media.read")]],
        ["cron", [getMedia]],
      ],
      ["getMedia", "open", "signedIn", "ungranted", "login", "noAnswer"],
    );
    expect(anonymousPipelines(config, manifest).map((p) => p.name)).toEqual(["getMedia", "open"]);
  });
});

describe("fieldGrantProblems", () => {
  const config: Config = { roles: { editor: ["*"] }, roleClaim: "roles", anonymous: ["media.read", "pages.read"], anonymousFields: { media: ["id", "variants[].path"], mediaFile: ["headers.cache-control"], pages: ["redirect", "id"] }, fields: {} };
  const passing = (): Array<[string, Array<PipelineManifest["steps"][number]>]> => [
    ["getMedia", [identify, gate("media.read"), getMedia, fields("media?shape=item")]],
    ["listMedia", [identify, gate("media.read"), listMedia, fields("media?shape=list")]],
    ["serveMediaFile", [identify, gate("media.read"), serve, fields("mediaFile?shape=file")]],
    ["resolvePage", [identify, gate("pages.read"), lookup, described("site.resolve", { writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }), fields("pages?shape=item")]],
  ];

  it("passes a set of pipelines that end with the step, grants that name declared fields and a covered early answer", () => {
    expect(fieldGrantProblems(config, fieldManifest(passing()))).toEqual([]);
  });

  it("refuses an anonymously answered pipeline that does not end with the step, naming the shape to cut", () => {
    const pipelines = passing();
    pipelines[1] = ["listMedia", [identify, gate("media.read"), listMedia]];
    expect(fieldGrantProblems(config, fieldManifest(pipelines))).toEqual([
      'authz/roles: pipeline "listMedia" answers anonymous callers but does not end with authz.fields:<resource>?shape=list – end it with the step, so that its answer carries only the fields anonymous callers may see',
    ]);
  });

  it("does not check a pipeline behind authn.requireUser or an ungranted permission, nor the login pipeline", () => {
    const manifest = fieldManifest([
      ...passing(),
      ["adminMedia", [described("authn.requireUser", { writes: ["identity"], security: "required" }), getMedia]],
      ["writeMedia", [identify, gate("media.write"), getMedia]],
      ["login", [described("authn.login", { writes: ["token", "identity", "result"] })]],
    ]);
    expect(fieldGrantProblems(config, manifest)).toEqual([]);
  });

  it("refuses a step after authz.fields", () => {
    const pipelines = passing();
    pipelines[0] = ["getMedia", [identify, gate("media.read"), getMedia, fields("media?shape=item"), described("images.attach", { writes: ["result.variants?"] })]];
    expect(fieldGrantProblems(config, fieldManifest(pipelines))).toContain('authz/roles: pipeline "getMedia" runs images.attach after authz.fields:media?shape=item – authz.fields must be the last step');
  });

  it("refuses a shape parameter the declared output contradicts", () => {
    const pipelines = passing();
    pipelines[1] = ["listMedia", [identify, gate("media.read"), listMedia, fields("media?shape=item")]];
    expect(fieldGrantProblems(config, fieldManifest(pipelines))).toEqual(['authz/roles: pipeline "listMedia" ends with authz.fields:media?shape=item, but its declared output is a list ({ items, total }) – write authz.fields:media?shape=list']);
  });

  it("refuses an anonymously answered resource without an anonymous grant", () => {
    const { mediaFile: _mediaFile, ...rest } = config.anonymousFields!;
    void _mediaFile;
    expect(fieldGrantProblems({ ...config, anonymousFields: rest }, fieldManifest(passing()))).toEqual(['authz/roles: pipeline "serveMediaFile" answers anonymous callers and ends with authz.fields:mediaFile, but anonymousFields grants nothing for "mediaFile"']);
  });

  it("refuses a grant naming a field no pipeline of its resource declares, with the way to write it where there is one", () => {
    const problems = fieldGrantProblems({ ...config, anonymousFields: { ...config.anonymousFields, media: ["id", "folderr", "variants.path"] }, fields: { editor: { media: ["headers.x"] } } }, fieldManifest(passing()));
    expect(problems).toEqual([
      'authz/roles: anonymousFields.media names "folderr", which no pipeline ending with authz.fields:media declares',
      'authz/roles: anonymousFields.media names "variants.path", which no pipeline ending with authz.fields:media declares – "variants" is a list, write "variants[].path"',
      'authz/roles: fields.editor.media names "headers.x", which no pipeline ending with authz.fields:media declares',
    ]);
  });

  it("accepts only headers.<name> for a file answer", () => {
    const problems = fieldGrantProblems({ ...config, anonymousFields: { ...config.anonymousFields, mediaFile: ["headers", "id", "headers.cache-control"] } }, fieldManifest(passing()));
    expect(problems).toEqual([
      'authz/roles: anonymousFields.mediaFile names "headers", which no pipeline ending with authz.fields:mediaFile declares – name each header as "headers.<name>"',
      'authz/roles: anonymousFields.mediaFile names "id", which no pipeline ending with authz.fields:mediaFile declares – name each header as "headers.<name>"',
    ]);
  });

  it("refuses a grant for a resource no pipeline cuts", () => {
    expect(fieldGrantProblems({ ...config, anonymousFields: { ...config.anonymousFields, settings: ["id"] }, fields: { editor: { users: ["id"] } } }, fieldManifest(passing()))).toEqual([
      'authz/roles: anonymousFields grants fields of "settings", but no pipeline ends with authz.fields:settings',
      'authz/roles: fields.editor grants fields of "users", but no pipeline ends with authz.fields:users',
    ]);
  });

  it("refuses an early answer before the step that carries an ungranted member or is open", () => {
    const ungranted = fieldGrantProblems({ ...config, anonymousFields: { ...config.anonymousFields, pages: ["id"] } }, fieldManifest(passing()));
    expect(ungranted).toEqual(['authz/roles: pipeline "resolvePage" can end at redirects.lookup before authz.fields:pages, and that answer carries "redirect", which anonymousFields.pages does not grant']);
    const pipelines = passing();
    const openLookup = described("redirects.lookup", { writes: ["result?"], terminalOutput: { type: "object", properties: { redirect: { type: "string" } }, required: ["redirect"] } });
    pipelines[3] = ["resolvePage", [identify, gate("pages.read"), openLookup, described("site.resolve", { writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }), fields("pages?shape=item")]];
    expect(fieldGrantProblems(config, fieldManifest(pipelines))).toEqual(['authz/roles: pipeline "resolvePage" can end at redirects.lookup before authz.fields:pages, and that answer is an open object at the root, which no grant can bound']);
  });
});
