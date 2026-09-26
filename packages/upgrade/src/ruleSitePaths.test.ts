import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { BootCheck, BootProblem, ModuleDefinition } from "@michaelthielemann/kestrel";
import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import { applyEdits } from "./apply.ts";
import { findAll, isAstNode, objectProperty } from "./ast.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { readFileOrUndefined } from "./rules.ts";
import { pathEventsRule, pathWiringRule, redirectsImplRule, redirectsPersistenceRule, routedSlugUniqueRule } from "./ruleSitePaths.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-site-paths-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function provider(name: string, contract?: string): ModuleDefinition {
  return { name, provides: contract === undefined ? [] : [defineContract<{ ping(): void }>()(contract, ["ping"])], requires: [], configSchema: z.object({}), async setup() { return {}; } };
}

const CONFIG = `import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    {
      use: "@michaelthielemann/kestrel-content-default",
      config: {
        types: {
          pages: { kind: "multi", fields: { slug: { type: "slug", required: true, unique: true, localized: true }, title: { type: "text" } } },
        },
      },
    },
    { use: "@michaelthielemann/kestrel-site-default", config: { routes: { pages: { home: "home" } } } },
  ],
  triggers: [],
});
`;

interface Options {
  modules?: Array<{ use: string; config?: Record<string, unknown> }>;
  definitions?: ModuleDefinition[];
  triggers?: unknown[];
  errors?: BootProblem[];
  moduleFiles?: Record<string, string>;
}

async function context(options: Options = {}): Promise<RuleContext> {
  const configFile = join(dir, "kestrel.config.ts");
  await writeFile(configFile, CONFIG);
  const project: LoadedProject = {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: { config: { modules: options.modules ?? [], triggers: (options.triggers ?? []) as never }, modules: options.definitions ?? [], pipelines: [] },
    kind: "backend",
    configFile,
    moduleFiles: new Map(Object.entries(options.moduleFiles ?? {})),
    pipelineFiles: [],
  };
  const bootCheck: BootCheck = { errors: options.errors ?? [], warnings: [], notChecked: [] };
  return { root: dir, scratch: dir, project, bootCheck, readFile: readFileOrUndefined, answers: new Map() };
}

const CONTENT = { use: "@michaelthielemann/kestrel-content-default", config: { types: { pages: { kind: "multi", fields: { slug: { type: "slug", required: true, unique: true, localized: true } } } } } };

describe("site/routed-slug-unique", () => {
  it("removes unique from the slug of a routed type, as an error once the type has parents", async () => {
    const ctx = await context({ modules: [CONTENT, { use: "@michaelthielemann/kestrel-site-default", config: { routes: { pages: { home: "home", parentField: "parent" } } } }] });
    const findings = await routedSlugUniqueRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.where.module).toBe("site/default");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(CONFIG, edits);
    expect(text).toContain('slug: { type: "slug", required: true, localized: true }');
  });

  it("is a warning for flat routes and silent for unrouted types or a slug without unique", async () => {
    const flat = await context({ modules: [CONTENT, { use: "@michaelthielemann/kestrel-site-default", config: { routes: { pages: {} } } }] });
    expect((await routedSlugUniqueRule.check(flat))[0]).toMatchObject({ severity: "warning", where: { module: CONTENT.use } });
    const unrouted = await context({ modules: [CONTENT, { use: "@michaelthielemann/kestrel-site-default", config: {} }] });
    expect(await routedSlugUniqueRule.check(unrouted)).toEqual([]);
  });
});

describe("site/routed-slug-unique with a model outside kestrel.config.ts", () => {
  it("edits the file and the fields the project's model hooks point at", async () => {
    const modelFile = join(dir, "model.ts");
    const modelSource = 'export const pages = { kind: "multi", fields: { slug: { type: "slug", unique: true, localized: true }, title: { type: "text" } } };\n';
    await writeFile(modelFile, modelSource);
    const base = await context({ modules: [CONTENT, { use: "@michaelthielemann/kestrel-site-default", config: { routes: { pages: { parentField: "parent" } } } }] });
    const ctx: RuleContext = {
      ...base,
      project: { ...base.project, contentModel: { types: { pages: { fields: { slug: {}, title: {} } } }, use: "preset", file: modelFile } },
      locateModelFields: (root, { typeName }) => {
        const declaration = findAll(root, "VariableDeclarator").find((d) => isAstNode(d.id) && d.id.name === typeName);
        const init = declaration && isAstNode(declaration.init) ? declaration.init : undefined;
        return init === undefined ? undefined : objectProperty(init, "fields");
      },
    };
    const findings = await routedSlugUniqueRule.check(ctx);
    expect(findings[0]?.where.file).toBe(modelFile);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    expect(applyEdits(modelSource, edits).text).toContain('slug: { type: "slug", localized: true }');
  });
});

describe("site/path-events", () => {
  const site = { use: "@michaelthielemann/kestrel-site-default", config: { routes: { pages: { home: "home" } } } };

  it("reports routes without an events@1 provider", async () => {
    const findings = await pathEventsRule.check(await context({ modules: [site] }));
    expect(findings.map((f) => [f.id, f.severity, f.where.module])).toEqual([["site/path-events:events", "error", "site/default"]]);
  });

  it("warns when nothing runs on site.pathsMoved, and is silent when something does", async () => {
    const definitions = [provider("events/inmemory", "events@1")];
    expect((await pathEventsRule.check(await context({ modules: [site], definitions })))[0]).toMatchObject({ severity: "warning", where: { module: site.use } });
    expect(await pathEventsRule.check(await context({ modules: [site], definitions, triggers: [{ event: "site.pathsMoved", pipeline: "pathsMovedRedirects" }] }))).toEqual([]);
  });
});

describe("site/path-wiring", () => {
  it("turns site-default's attach failure into a finding naming the missing step", async () => {
    const reason = 'attach() threw: site/default: pipeline "updatePage": the atomic group with content.update:pages must end with site.indexPath:pages (it ends with content.update:pages)';
    const findings = await pathWiringRule.check(await context({ errors: [{ code: "attach-failed", owner: "site/default", module: "site/default", reason }] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "site/path-wiring", message: reason, where: { module: "site/default" } });
    expect(await pathWiringRule.check(await context({ errors: [{ code: "attach-failed", owner: "delivery/static", module: "delivery/static", reason: "something else" }] }))).toEqual([]);
  });
});

describe("redirects/requires-persistence", () => {
  const redirects = { use: "@michaelthielemann/kestrel-redirects-default", config: {} };

  it("reports redirects-default without a persistence@1 provider, and is silent with one", async () => {
    expect((await redirectsPersistenceRule.check(await context({ modules: [redirects] }))).map((f) => [f.rule, f.where.module])).toEqual([["redirects/requires-persistence", "redirects/default"]]);
    expect(await redirectsPersistenceRule.check(await context({ modules: [redirects], definitions: [provider("persistence/sqlite", "persistence@1")] }))).toEqual([]);
  });
});

describe("imports/redirects-impl", () => {
  it("points a local module importing redirects-default's impl at the async createRedirects", async () => {
    const file = join(dir, "custom.ts");
    await writeFile(file, 'import { createRedirects } from "@michaelthielemann/kestrel-redirects-default/impl";\n');
    const findings = await redirectsImplRule.check(await context({ moduleFiles: { "custom/redirects": file } }));
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([["imports/redirects-impl", "info"]]);
  });
});
