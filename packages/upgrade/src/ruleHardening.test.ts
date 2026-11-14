import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, ok, stepFactory, type Context, type ModuleDefinition, type PipelineDefinition } from "@michaelthielemann/kestrel";
import { configSchema as authzRolesConfigSchema } from "@michaelthielemann/kestrel-authz-roles";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { upgradingDocs } from "./ruleHelpers.ts";
import { HARDENING_RULES, anonymousReadOnlyRule, queryBodyMemberRule, sortFieldGrantRule, userCleanupGuardRule } from "./ruleHardening.ts";
import { DEFAULT_RULES, readFileOrUndefined } from "./rules.ts";

const AUTHZ_ROLES = "@michaelthielemann/kestrel-authz-roles";
const AUTHN_MULTI = "@michaelthielemann/kestrel-authn-multi";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-hardening-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface ProjectOptions {
  modules?: Array<{ use: string; config?: Record<string, unknown> }>;
  triggers?: Array<{ http?: string; event?: string; cron?: string; pipeline: string }>;
  pipelines?: PipelineDefinition[];
  loaded?: ModuleDefinition[];
  moduleFiles?: Record<string, string>;
}

function project(options: ProjectOptions = {}): LoadedProject {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: { config: { modules: options.modules ?? [], triggers: (options.triggers ?? []) as never }, modules: options.loaded ?? [], pipelines: options.pipelines ?? [] },
    kind: "backend",
    configFile: join(dir, "kestrel.config.ts"),
    moduleFiles: new Map(Object.entries(options.moduleFiles ?? {})),
    pipelineFiles: (options.pipelines ?? []).map((p) => ({ file: join(dir, "pipelines", `${p.name}.ts`), pipelines: [p.name] })),
  };
}

function contextFor(p: LoadedProject): RuleContext {
  return { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map() };
}

describe("authz/anonymous-read-only", () => {
  const authz = (anonymous: unknown) => project({ modules: [{ use: AUTHZ_ROLES, config: { roles: {}, anonymous } }] });

  it("names a wildcard entry in anonymous", async () => {
    const findings = await anonymousReadOnlyRule.check(contextFor(authz(["*"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", fix: { kind: "manual" }, docs: upgradingDocs("authz-anonymous-read-only"), where: { module: AUTHZ_ROLES, path: "anonymous" } });
    expect(findings[0]?.message).toContain('"*"');
  });

  it("names a resource wildcard", async () => {
    const findings = await anonymousReadOnlyRule.check(contextFor(authz(["pages.*"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"pages.*"');
  });

  it("names entries that write, manage or list, and lists every offender in one finding", async () => {
    const findings = await anonymousReadOnlyRule.check(contextFor(authz(["site.read", "pages.write", "media.list", "users.manage"])));
    expect(findings).toHaveLength(1);
    const message = findings[0]?.message ?? "";
    expect(message).toContain('"pages.write"');
    expect(message).toContain('"media.list"');
    expect(message).toContain('"users.manage"');
    expect(message).not.toContain('"site.read"');
  });

  it("names an entry that is not a string", async () => {
    const findings = await anonymousReadOnlyRule.check(contextFor(authz(["pages.read", 7])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("7");
  });

  it("stays quiet for read permissions only", async () => {
    expect(await anonymousReadOnlyRule.check(contextFor(authz(["pages.read", "media.read", "site.nav.read"])))).toEqual([]);
  });

  it("stays quiet for an empty or missing anonymous list and without authz-roles", async () => {
    expect(await anonymousReadOnlyRule.check(contextFor(authz([])))).toEqual([]);
    expect(await anonymousReadOnlyRule.check(contextFor(project({ modules: [{ use: AUTHZ_ROLES, config: { roles: {} } }] })))).toEqual([]);
    expect(await anonymousReadOnlyRule.check(contextFor(project()))).toEqual([]);
  });

  it("reads the module's effective config, so a default-supplied entry counts", async () => {
    const p = project({ modules: [{ use: AUTHZ_ROLES, config: { roles: {} } }] });
    const entry = p.input.config.modules[0]!;
    const withDefaults = { ...p, input: { ...p.input, config: { ...p.input.config, modules: [{ ...entry, defaults: { from: "host", values: { anonymous: ["*"] } } }] } } };
    expect(await anonymousReadOnlyRule.check(contextFor(withDefaults))).toHaveLength(1);
  });

  describe("the boot error for the same entries", () => {
    const issues = (anonymous: unknown[]) => {
      const parsed = authzRolesConfigSchema.safeParse({ roles: {}, anonymous });
      return parsed.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") ?? "";
    };
    const withBootError = (anonymous: unknown[], reason: string) => ({
      ...contextFor(authz(anonymous)),
      bootCheck: { errors: [{ code: "invalid-module-config" as const, owner: "authz/roles", module: "authz/roles", reason }], warnings: [], notChecked: [] },
    });

    it("is claimed through the module name when it names only the anonymous entries", async () => {
      for (const anonymous of [["pages.*"], ["pages.write", "pages.read", "*"]]) {
        const ctx = withBootError(anonymous, `invalid config: ${issues(anonymous)}`);
        expect((await anonymousReadOnlyRule.check(ctx))[0]?.where).toEqual({ module: "authz/roles", path: "anonymous" });
      }
    });

    it("is claimed when the config came with host defaults", async () => {
      const ctx = withBootError(["*"], `invalid config (with defaults from "host"): ${issues(["*"])}`);
      expect((await anonymousReadOnlyRule.check(ctx))[0]?.where.module).toBe("authz/roles");
    });

    it("is left to the boot tier when it names another config issue too", async () => {
      const ctx = withBootError(["*"], `invalid config: ${issues(["*"])}; roles: Invalid input`);
      expect((await anonymousReadOnlyRule.check(ctx))[0]?.where.module).toBe(AUTHZ_ROLES);
    });
  });

  it("agrees with the authz-roles config schema on which entries are accepted", async () => {
    const entries = ["*", "pages.*", "pages.read", "pages.write", "pages.manage", "media.list", "media.read", "a.b.c.read", "Pages.read", "pages.read ", "pages", "read", ".read", "pages..read", "pages.READ", "my_type-1.read", ""];
    for (const entry of entries) {
      const accepted = authzRolesConfigSchema.safeParse({ roles: {}, anonymous: [entry] }).success;
      const findings = await anonymousReadOnlyRule.check(contextFor(authz([entry])));
      expect(findings.length === 0, `entry ${JSON.stringify(entry)}`).toBe(accepted);
    }
  });
});

function customModule(options: { query?: string[]; input?: string[]; name?: string } = {}): ModuleDefinition {
  const input = options.input ?? ["role"];
  const query = options.query;
  return defineModule({
    name: options.name ?? "custom/module",
    provides: [],
    requires: [],
    configSchema: z.object({}),
    async setup() {
      return {};
    },
    steps() {
      return { assign: async (ctx: Context) => ok(ctx) };
    },
    describe() {
      return {
        assign: {
          summary: "assigns",
          reads: [],
          writes: [],
          input: { type: "object", properties: Object.fromEntries(input.map((k) => [k, { type: "string" }])) },
          ...(query === undefined ? {} : { query: Object.fromEntries(query.map((k) => [k, { type: "string" }])) }),
        },
      };
    },
  });
}

function factoryModule(options: { query?: string[]; input?: string[]; throwing?: boolean; staticDescription?: boolean } = {}): ModuleDefinition {
  const input = options.input ?? ["role"];
  const query = options.query;
  return defineModule({
    name: "custom/module",
    provides: [],
    requires: [],
    configSchema: z.object({}),
    async setup() {
      return {};
    },
    steps() {
      return { assign: stepFactory(() => async (ctx: Context) => ok(ctx)) };
    },
    describe() {
      if (options.staticDescription === true) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/consistent-type-assertions
        return {
          assign: {
            summary: "assigns",
            reads: [],
            writes: [],
            input: { type: "object", properties: Object.fromEntries(input.map((k) => [k, { type: "string" }])) },
            ...(query === undefined ? {} : { query: Object.fromEntries(query.map((k) => [k, { type: "string" }])) }),
          },
        } as never;
      }
      return {
        assign: (arg: string) => {
          if (options.throwing === true) throw new Error(`no description for ${arg}`);
          return {
            summary: `assigns ${arg}`,
            reads: [],
            writes: [],
            input: { type: "object", properties: Object.fromEntries(input.map((k) => [k, { type: "string" }])) },
            ...(query === undefined ? {} : { query: Object.fromEntries(query.map((k) => [k, { type: "string" }])) }),
          };
        },
      };
    },
  });
}

describe("pipelines/query-body-member", () => {
  async function scenario(source: string, options: { query?: string[]; input?: string[]; http?: boolean; steps?: string[]; trigger?: string } = {}) {
    const file = join(dir, "custom.ts");
    await writeFile(file, source);
    return project({
      loaded: [customModule(options)],
      moduleFiles: { "custom/module": file },
      pipelines: [{ name: "assignRole", steps: options.steps ?? ["custom.assign"] }],
      triggers: [options.http === false ? { event: "x.y", pipeline: "assignRole" } : { http: options.trigger ?? "POST /assign", pipeline: "assignRole" }],
    });
  }

  it("reports a step that reads a member of its input schema from the query without declaring it", async () => {
    const p = await scenario('const role = ctx.query.role;\n');
    const findings = await queryBodyMemberRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", fix: { kind: "manual" }, docs: upgradingDocs("pipelines-query-body-member"), where: { pipeline: "assignRole" } });
    expect(findings[0]?.message).toContain("custom.assign");
    expect(findings[0]?.message).toContain('"role"');
  });

  it("recognises bracket and optional-chaining reads", async () => {
    for (const source of ['const r = ctx.query["role"];\n', "const r = ctx.query?.role;\n", "const r = ctx.query['role'];\n"]) {
      const findings = await queryBodyMemberRule.check(contextFor(await scenario(source)));
      expect(findings, source).toHaveLength(1);
    }
  });

  it("stays quiet when the step declares the key in describe().query", async () => {
    const p = await scenario("const role = ctx.query.role;\n", { query: ["role"] });
    expect(await queryBodyMemberRule.check(contextFor(p))).toEqual([]);
  });

  it("stays quiet when the module never reads that key from the query", async () => {
    const p = await scenario("const role = ctx.body.role; const other = ctx.query.page;\n");
    expect(await queryBodyMemberRule.check(contextFor(p))).toEqual([]);
  });

  it("does not match a longer name that only starts with the key", async () => {
    const p = await scenario("const r = ctx.query.roleName;\n");
    expect(await queryBodyMemberRule.check(contextFor(p))).toEqual([]);
  });

  it("stays quiet when no HTTP pipeline runs the step", async () => {
    expect(await queryBodyMemberRule.check(contextFor(await scenario("const role = ctx.query.role;\n", { http: false })))).toEqual([]);
    expect(await queryBodyMemberRule.check(contextFor(await scenario("const role = ctx.query.role;\n", { steps: ["content.list:pages"] })))).toEqual([]);
  });

  it("recognises a destructuring read from the query", async () => {
    for (const source of ["const { role } = ctx.query;\n", "const { page, role = 'x' } = ctx.query;\n", "const { query } = ctx;\nconst { role: r } = query;\n", "const { role: r } = ctx.query;\n", 'const { "role": r } = ctx.query;\n', "const { role } = ctx?.query ?? {};\n"]) {
      const findings = await queryBodyMemberRule.check(contextFor(await scenario(source)));
      expect(findings, source).toHaveLength(1);
    }
  });

  it("does not take a destructuring that only renames into the key for a read of it", async () => {
    for (const source of ["const { page: role } = ctx.query;\n", "const { role } = ctx.body;\n", "const { role } = ctx.query.nested;\n", "const { roleName } = ctx.query;\n"]) {
      expect(await queryBodyMemberRule.check(contextFor(await scenario(source))), source).toEqual([]);
    }
  });

  describe("on a route without a request body", () => {
    it("reports every input member the step does not declare in its query, without a read in the source", async () => {
      for (const trigger of ["GET /assign", "HEAD /assign", "get /assign"]) {
        const findings = await queryBodyMemberRule.check(contextFor(await scenario("const role = ctx.payload.role;\n", { trigger })));
        expect(findings, trigger).toHaveLength(1);
        expect(findings[0]).toMatchObject({ severity: "warning", fix: { kind: "manual" }, docs: upgradingDocs("pipelines-query-body-member"), where: { pipeline: "assignRole" } });
        expect(findings[0]?.message).toContain('"role"');
        expect(findings[0]?.message).toContain(trigger);
      }
    });

    it("reports one finding per undeclared member", async () => {
      const findings = await queryBodyMemberRule.check(contextFor(await scenario("", { trigger: "GET /assign", input: ["role", "page", "q"], query: ["page"] })));
      expect(findings.map((f) => f.id).sort()).toEqual(["pipelines/query-body-member:assignRole:custom.assign:q", "pipelines/query-body-member:assignRole:custom.assign:role"]);
    });

    it("stays quiet for members the step declares in its query", async () => {
      expect(await queryBodyMemberRule.check(contextFor(await scenario("const role = ctx.payload.role;\n", { trigger: "GET /assign", query: ["role"] })))).toEqual([]);
    });

    it("reports a member once when the source reads it from the query as well", async () => {
      const findings = await queryBodyMemberRule.check(contextFor(await scenario("const role = ctx.query.role;\n", { trigger: "GET /assign" })));
      expect(findings).toHaveLength(1);
    });

    it("applies to a pipeline that a GET trigger and another trigger both start", async () => {
      const p = await scenario("const role = ctx.payload.role;\n");
      const both = { ...p, input: { ...p.input, config: { ...p.input.config, triggers: [...p.input.config.triggers, { http: "GET /assign", pipeline: "assignRole" }] } } };
      expect(await queryBodyMemberRule.check(contextFor(both))).toHaveLength(1);
    });

    it("leaves a route that takes a body to the source reads", async () => {
      for (const trigger of ["POST /assign", "PUT /assign", "PATCH /assign", "DELETE /assign"]) {
        expect(await queryBodyMemberRule.check(contextFor(await scenario("const role = ctx.payload.role;\n", { trigger }))), trigger).toEqual([]);
      }
    });

    it("stays quiet for a GET pipeline that runs no step of the project's own modules", async () => {
      const p = project({ pipelines: [{ name: "assignRole", steps: ["content.list:pages"] }], triggers: [{ http: "GET /pages", pipeline: "assignRole" }] });
      expect(await queryBodyMemberRule.check(contextFor(p))).toEqual([]);
    });
  });

  describe("reads of the query inside the module file", () => {
    const twoSteps = (listBody: string, createBody: string) => `
import { defineModule } from "@michaelthielemann/kestrel";
export default defineModule({
  steps() {
    return {
      list: async (ctx) => {
${listBody}
        return ctx;
      },
      create: async (ctx) => {
${createBody}
        return ctx;
      },
    };
  },
});
`;

    async function members(source: string, step: string) {
      const file = join(dir, "members.ts");
      await writeFile(file, source);
      const entry = (query: string[]) => ({ summary: "s", reads: [], writes: [], input: { type: "object", properties: { name: { type: "string" }, role: { type: "string" } } }, ...(query.length === 0 ? {} : { query: Object.fromEntries(query.map((k) => [k, { type: "string" }])) }) });
      const module = defineModule({
        name: "members/local",
        provides: [],
        requires: [],
        configSchema: z.object({}),
        async setup() {
          return {};
        },
        steps() {
          return { list: async (ctx: Context) => ok(ctx), create: async (ctx: Context) => ok(ctx) };
        },
        describe() {
          return { list: entry(["role"]), create: entry([]) };
        },
      });
      const p = project({ loaded: [module], moduleFiles: { "members/local": file }, pipelines: [{ name: "run", steps: [step] }], triggers: [{ http: "POST /members", pipeline: "run" }] });
      return queryBodyMemberRule.check(contextFor(p));
    }

    it("ignores a read of the query that belongs to another step of the same file", async () => {
      expect(await members(twoSteps("const r = ctx.query.role;", "const r = ctx.body.role;"), "members.create")).toEqual([]);
    });

    it("still reports the step whose own function reads the key", async () => {
      const findings = await members(twoSteps("const r = ctx.body.role;", "const r = ctx.query.role;"), "members.create");
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('"role"');
    });

    it("ignores a local variable that is only named query", async () => {
      const source = twoSteps("", 'const query = { role: ctx.body.role ?? "member" };\n        const found = query.role;');
      expect(await members(source, "members.create")).toEqual([]);
    });

    it("follows a query taken out of the context and an alias of it", async () => {
      for (const body of ["const { query } = ctx;\n        const r = query.role;", "const q = ctx.query;\n        const r = q.role;", "const { role } = ctx.query ?? {};", "const r = (ctx.query as Record<string, string>).role;"]) {
        expect(await members(twoSteps("", body), "members.create"), body).toHaveLength(1);
      }
    });

    it("follows a step that is a named function of the file", async () => {
      const source = `
export default defineModule({
  steps() {
    return { create: createMember, list };
  },
});
function createMember(ctx) {
  return helper(ctx);
}
const helper = (ctx) => ctx.query.role;
const list = (ctx) => ctx.body.role;
`;
      expect(await members(source, "members.create")).toHaveLength(1);
      expect(await members(source, "members.list")).toEqual([]);
    });

    it("follows a step written as an object method", async () => {
      const source = `
export default defineModule({
  steps() {
    return {
      create(ctx) {
        return ctx.query.role;
      },
    };
  },
});
`;
      expect(await members(source, "members.create")).toHaveLength(1);
    });
  });

  describe("for a step factory", () => {
    async function factoryScenario(options: { query?: string[]; input?: string[]; throwing?: boolean; staticDescription?: boolean; steps?: string[]; source?: string } = {}) {
      const file = join(dir, "custom.ts");
      await writeFile(file, options.source ?? "const role = ctx.query.role;\n");
      return project({
        loaded: [factoryModule(options)],
        moduleFiles: { "custom/module": file },
        pipelines: [{ name: "assignRole", steps: options.steps ?? ["custom.assign:x"] }],
        triggers: [{ http: "POST /assign", pipeline: "assignRole" }],
      });
    }

    it("resolves the description with the argument the pipeline gives", async () => {
      const findings = await queryBodyMemberRule.check(contextFor(await factoryScenario()));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("custom.assign:x");
      expect(findings[0]?.message).toContain('"role"');
    });

    it("reports once per distinct argument", async () => {
      const findings = await queryBodyMemberRule.check(contextFor(await factoryScenario({ steps: ["custom.assign:x", "custom.assign:y", "custom.assign:x"] })));
      expect(findings.map((f) => f.id).sort()).toEqual(["pipelines/query-body-member:assignRole:custom.assign:x:role", "pipelines/query-body-member:assignRole:custom.assign:y:role"]);
    });

    it("stays quiet when the step declares the key in describe().query", async () => {
      expect(await queryBodyMemberRule.check(contextFor(await factoryScenario({ query: ["role"] })))).toEqual([]);
    });

    it("uses a static description for every argument, and for none", async () => {
      for (const steps of [["custom.assign:x"], ["custom.assign"]]) {
        const findings = await queryBodyMemberRule.check(contextFor(await factoryScenario({ staticDescription: true, steps })));
        expect(findings, steps.join()).toHaveLength(1);
        expect(findings[0]?.message).toContain('"role"');
      }
      expect(await queryBodyMemberRule.check(contextFor(await factoryScenario({ staticDescription: true, query: ["role"] })))).toEqual([]);
    });

    it("stays quiet without an argument, and when the description cannot be resolved for it", async () => {
      expect(await queryBodyMemberRule.check(contextFor(await factoryScenario({ steps: ["custom.assign"] })))).toEqual([]);
      expect(await queryBodyMemberRule.check(contextFor(await factoryScenario({ throwing: true })))).toEqual([]);
    });
  });

  it("stays quiet for an installed package's file", async () => {
    const file = join(dir, "node_modules", "pkg", "module.ts");
    const p = { ...(await scenario("")), moduleFiles: new Map([["custom/module", file]]) };
    expect(await queryBodyMemberRule.check(contextFor(p))).toEqual([]);
  });

  it("skips a module whose describe() throws", async () => {
    const file = join(dir, "custom.ts");
    await writeFile(file, "const role = ctx.query.role;\n");
    const throwing: ModuleDefinition = {
      ...customModule(),
      describe() {
        throw new Error("needs the instance");
      },
    };
    const p = project({ loaded: [throwing], moduleFiles: { "custom/module": file }, pipelines: [{ name: "assignRole", steps: ["custom.assign"] }], triggers: [{ http: "POST /assign", pipeline: "assignRole" }] });
    expect(await queryBodyMemberRule.check(contextFor(p))).toEqual([]);
  });

  it("names a pipeline over HTTP that runs migrations.apply, which reads dry from the body only", async () => {
    const p = project({ pipelines: [{ name: "applyMigrations", steps: ["authn.requireUser", "migrations.apply"] }], triggers: [{ http: "POST /admin/migrations/apply", pipeline: "applyMigrations" }] });
    const findings = await queryBodyMemberRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "info", fix: { kind: "none" }, docs: upgradingDocs("pipelines-query-body-member") });
    expect(findings[0]?.message).toContain("dry");
  });

  it("stays quiet for migrations.apply outside an HTTP pipeline", async () => {
    const p = project({ pipelines: [{ name: "applyMigrations", steps: ["migrations.apply"] }], triggers: [{ event: "boot.done", pipeline: "applyMigrations" }] });
    expect(await queryBodyMemberRule.check(contextFor(p))).toEqual([]);
  });
});

describe("runtime/sort-field-grant", () => {
  const listing = (steps: string[], http = true) => project({ pipelines: [{ name: "listPages", steps }], triggers: [http ? { http: "GET /pages", pipeline: "listPages" } : { cron: "0 * * * *", pipeline: "listPages" }] });

  it("names an HTTP pipeline that lists content and says what a sort may name", async () => {
    const findings = await sortFieldGrantRule.check(contextFor(listing(["content.list:pages"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "info", fix: { kind: "none" }, docs: upgradingDocs("runtime-sort-field-grant"), where: { pipeline: "listPages" } });
    expect(findings[0]?.message).toContain("pages");
    expect(findings[0]?.message).toContain("constructor");
    expect(findings[0]?.message).not.toContain("field grant");
  });

  it("names a pipeline that ends a list with authz.fields, whatever step produces the list", async () => {
    const findings = await sortFieldGrantRule.check(contextFor(listing(["search.pages", "authz.fields:pages?shape=list"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("pages");
    expect(findings[0]?.message).toContain("field grant");
    expect(findings[0]?.message).not.toContain("constructor");
  });

  it("says both things for a content list that authz.fields narrows", async () => {
    const findings = await sortFieldGrantRule.check(contextFor(listing(["content.list:pages", "authz.fields:pages?shape=list"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("field grant");
    expect(findings[0]?.message).toContain("constructor");
  });

  it("names a media listing only when authz.fields narrows it", async () => {
    const findings = await sortFieldGrantRule.check(contextFor(listing(["media.list", "authz.fields:media?shape=list"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("media");
    expect(findings[0]?.message).not.toContain("constructor");
    expect(await sortFieldGrantRule.check(contextFor(listing(["authn.identifyUser", "media.list"])))).toEqual([]);
  });

  it("ignores authz.fields for a shape other than a list", async () => {
    expect(await sortFieldGrantRule.check(contextFor(listing(["media.download", "authz.fields:mediaFile?shape=file"])))).toEqual([]);
    expect(await sortFieldGrantRule.check(contextFor(listing(["content.get:pages", "authz.fields:pages?shape=item"])))).toEqual([]);
  });

  it("reports one finding per pipeline even when it lists twice", async () => {
    expect(await sortFieldGrantRule.check(contextFor(listing(["content.list:pages", "content.list:posts"])))).toHaveLength(1);
    expect(await sortFieldGrantRule.check(contextFor(listing(["authz.fields:pages?shape=list", "authz.fields:posts?shape=list"])))).toHaveLength(1);
  });

  it("stays quiet for a pipeline that is not reachable over HTTP or lists nothing", async () => {
    expect(await sortFieldGrantRule.check(contextFor(listing(["content.list:pages", "authz.fields:pages?shape=list"], false)))).toEqual([]);
    expect(await sortFieldGrantRule.check(contextFor(listing(["content.get:pages"])))).toEqual([]);
  });
});

describe("runtime/user-cleanup-guard", () => {
  const route = (steps: string[], modules: Array<{ use: string }> = [{ use: AUTHN_MULTI }], http = true) =>
    project({ modules, pipelines: [{ name: "retryCleanup", steps }], triggers: [http ? { http: "POST /admin/users/:id/audit/anonymize", pipeline: "retryCleanup" } : { event: "user.deleted", pipeline: "retryCleanup" }] });

  it("reports an HTTP route running audit.anonymize without authn.requireAbsentUser before it", async () => {
    const findings = await userCleanupGuardRule.check(contextFor(route(["authn.requireUser", "audit.anonymize"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", fix: { kind: "manual" }, docs: upgradingDocs("runtime-user-cleanup-guard"), where: { pipeline: "retryCleanup" } });
    expect(findings[0]?.message).toContain("audit.anonymize");
    expect(findings[0]?.suggestion).toContain("authn.requireAbsentUser");
  });

  it("reports an HTTP route running revisions.reassignAuthor", async () => {
    const findings = await userCleanupGuardRule.check(contextFor(route(["authn.requireUser", "authn.verifyUser:reassignTo", "revisions.reassignAuthor"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revisions.reassignAuthor");
  });

  it("reports a guard that runs after the step", async () => {
    expect(await userCleanupGuardRule.check(contextFor(route(["audit.anonymize", "authn.requireAbsentUser"])))).toHaveLength(1);
  });

  it("stays quiet when authn.requireAbsentUser runs first", async () => {
    expect(await userCleanupGuardRule.check(contextFor(route(["authn.requireUser", "authn.requireAbsentUser", "audit.anonymize"])))).toEqual([]);
  });

  it("stays quiet for a pipeline only an event starts", async () => {
    expect(await userCleanupGuardRule.check(contextFor(route(["audit.anonymize"], [{ use: AUTHN_MULTI }], false)))).toEqual([]);
  });

  it("tells a project without authn-multi to check the id by hand", async () => {
    const findings = await userCleanupGuardRule.check(contextFor(route(["audit.anonymize"], [])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestion).not.toContain("add authn.requireAbsentUser");
    expect(findings[0]?.suggestion).toContain("by hand");
  });
});

describe("hardening rules in the default set", () => {
  it("registers every hardening rule once", () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    for (const rule of HARDENING_RULES) expect(ids.filter((id) => id === rule.id)).toHaveLength(1);
    expect(HARDENING_RULES.map((r) => r.id).sort()).toEqual(["authz/anonymous-read-only", "pipelines/query-body-member", "runtime/sort-field-grant", "runtime/user-cleanup-guard"]);
  });
});
