import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BootCheck, BootProblem, PipelineDefinition } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { readFileOrUndefined } from "./rules.ts";
import { anonymousFieldsRule, fieldGrantUnknownRule, fieldStepRule, thrownErrorTextRule } from "./ruleFieldGrants.ts";
import { breakingStepShapesRule } from "./ruleInfo.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-fields-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const AUTHZ = "@michaelthielemann/kestrel-authz-roles";
const CONFIG_SOURCE = `export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-content-default", config: { locales: ["de", "en"], types: { pages: { kind: "multi", fields: { slug: "slug", title: "text" } } } } },
    { use: "@michaelthielemann/kestrel-media-default", config: {} },
    { use: "@michaelthielemann/kestrel-images-default", config: {} },
    { use: "${AUTHZ}", config: { roles: { admin: ["*"] }, anonymous: ["pages.read", "media.read"] } },
  ],
  triggers: [],
});
`;
interface ModuleEntry {
  use: string;
  config: Record<string, unknown>;
  defaults?: { from: string; values: Record<string, unknown> };
}

const MODULES: ModuleEntry[] = [
  { use: "@michaelthielemann/kestrel-content-default", config: { locales: ["de", "en"], types: { pages: { kind: "multi", fields: { slug: "slug", title: "text" } } } } },
  { use: "@michaelthielemann/kestrel-media-default", config: {} },
  { use: "@michaelthielemann/kestrel-images-default", config: {} },
  { use: AUTHZ, config: { roles: { admin: ["*"] }, anonymous: ["pages.read", "media.read"] } },
];
const PIPELINES: PipelineDefinition[] = [
  { name: "getMedia", steps: ["authn.identifyUser", "authz.require:media.read", "media.get", "images.attach"] },
  { name: "resolvePage", steps: ["authn.identifyUser", "authz.require:pages.read", "redirects.lookup", "site.resolve:pages?home=home&status=published&fallback=true"] },
  { name: "serveMediaFile", steps: ["authn.identifyUser", "authz.require:media.read", "media.serve"] },
  { name: "adminMedia", steps: ["authn.requireUser", "authz.require:media.read", "media.get"] },
];

async function project(options: { modules?: ModuleEntry[]; pipelines?: PipelineDefinition[]; triggers?: unknown[]; moduleFiles?: Record<string, string> } = {}): Promise<LoadedProject> {
  const configFile = join(dir, "kestrel.config.ts");
  await writeFile(configFile, CONFIG_SOURCE);
  const pipelines = options.pipelines ?? PIPELINES;
  await mkdir(join(dir, "pipelines"), { recursive: true });
  for (const p of pipelines) await writeFile(join(dir, "pipelines", `${p.name}.ts`), `export default definePipeline({\n  name: "${p.name}",\n  steps: [${p.steps.map((s) => JSON.stringify(s)).join(", ")}],\n});\n`);
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: { config: { modules: options.modules ?? MODULES, triggers: (options.triggers ?? []) as never }, modules: [], pipelines },
    kind: "backend",
    configFile,
    moduleFiles: new Map(Object.entries(options.moduleFiles ?? {})),
    pipelineFiles: pipelines.map((p) => ({ file: join(dir, "pipelines", `${p.name}.ts`), pipelines: [p.name] })),
  };
}

function attachFailed(lines: string[]): BootProblem {
  return { code: "attach-failed", owner: "authz/roles", module: "authz/roles", reason: `attach() threw: ${lines.join("\n")}` };
}

function contextFor(p: LoadedProject, errors: BootProblem[] = [], answers: Record<string, string> = {}): RuleContext {
  const bootCheck: BootCheck = { errors, warnings: [], notChecked: [] };
  return { root: dir, scratch: dir, project: p, bootCheck, readFile: readFileOrUndefined, answers: new Map(Object.entries(answers)) };
}

const missingStepLine = (pipeline: string, shape: string) => `authz/roles: pipeline "${pipeline}" answers anonymous callers but does not end with authz.fields:<resource>?shape=${shape} – end it with the step, so that its answer carries only the fields anonymous callers may see`;

describe("pipelines/field-step", () => {
  const problem = attachFailed([missingStepLine("getMedia", "item"), missingStepLine("resolvePage", "item"), missingStepLine("serveMediaFile", "file")]);

  it("asks once, with no default, to end every public read with authz.fields and grant the proposed fields", async () => {
    const findings = await fieldStepRule.check(contextFor(await project(), [problem]));
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toMatchObject({ rule: "pipelines/field-step", severity: "error", tier: "boot", where: { module: "authz/roles" }, fix: { kind: "ask", question: "field-step", choices: ["yes", "manual"], closedChoices: true } });
    expect(finding?.fix).not.toHaveProperty("defaultValue");
    expect(finding?.suggestion).toContain('getMedia → "authz.fields:media?shape=item"');
    expect(finding?.suggestion).toContain('resolvePage → "authz.fields:pages?shape=item"');
    expect(finding?.suggestion).toContain('serveMediaFile → "authz.fields:mediaFile?shape=file"');
    expect(finding?.suggestion).toContain("media: id, path, filename, contentType, size, width, height, alt, title, description, provenance, variants[].size, variants[].width, variants[].height, variants[].format, variants[].path");
    expect(finding?.suggestion).toContain("pages: id, slug, title, _locales, _translations, _locale, _links, redirect");
    expect(finding?.suggestion).toContain("mediaFile: headers.cache-control, headers.x-content-provenance, headers.x-kestrel-variant");
  });

  it("on yes, appends the step to each pipeline file and sets anonymousFields on authz-roles", async () => {
    const p = await project();
    const [finding] = await fieldStepRule.check(contextFor(p, [problem], { "field-step": "yes" }));
    expect(finding?.fix.kind).toBe("auto");
    const edits = finding!.fix.kind === "auto" ? finding!.fix.edits : [];
    const read = (file: string) => readFileOrUndefined(file) ?? "";
    const media = join(dir, "pipelines", "getMedia.ts");
    expect(applyEdits(read(media), edits.filter((e) => e.file === media)).text).toContain('"images.attach", "authz.fields:media?shape=item"]');
    const config = applyEdits(read(p.configFile), edits.filter((e) => e.file === p.configFile)).text;
    expect(config).toContain('anonymousFields: { media: ["id", "path", "filename"');
    expect(config).toContain('pages: ["id", "slug", "title", "_locales", "_translations", "_locale", "_links", "redirect"]');
    expect(config).toContain('mediaFile: ["headers.cache-control", "headers.x-content-provenance", "headers.x-kestrel-variant"]');
  });

  it("proposes only the grant for a pipeline that already ends with the step, keeping every existing grant", async () => {
    const modules = MODULES.map((m) => (m.use === AUTHZ ? { ...m, config: { ...m.config, anonymousFields: { pages: ["id", "title"] } } } : m));
    const p = await project({ modules, pipelines: [{ name: "getMedia", steps: ["authn.identifyUser", "authz.require:media.read", "media.get", "authz.fields:media?shape=item"] }] });
    const missingGrant = attachFailed(['authz/roles: pipeline "getMedia" answers anonymous callers and ends with authz.fields:media, but anonymousFields grants nothing for "media"']);
    const [asked] = await fieldStepRule.check(contextFor(p, [missingGrant]));
    expect(asked?.suggestion).not.toContain("→");
    expect(asked?.suggestion).toContain("media: id, path");
    const [finding] = await fieldStepRule.check(contextFor(p, [missingGrant], { "field-step": "yes" }));
    const edits = finding!.fix.kind === "auto" ? finding!.fix.edits : [];
    expect(edits.every((e) => e.file === p.configFile)).toBe(true);
    const text = applyEdits(readFileOrUndefined(p.configFile) ?? "", edits).text;
    expect(text).toContain('anonymousFields: { pages: ["id", "title"], media: ["id", "path"');
    expect(text).not.toContain("variants[]");
  });

  it("reads the content model and the existing grants from host-supplied defaults", async () => {
    const modules = MODULES.map((m) => (m.use.endsWith("content-default") ? { use: m.use, config: {}, defaults: { from: "site-preset", values: m.config } } : m.use === AUTHZ ? { ...m, defaults: { from: "site-preset", values: { anonymousFields: { settings: ["id"] } } } } : m));
    const p = await project({ modules });
    const [asked] = await fieldStepRule.check(contextFor(p, [problem]));
    expect(asked?.suggestion).toContain("pages: id, slug, title, _locales, _translations, _locale, _links, redirect");
    const [finding] = await fieldStepRule.check(contextFor(p, [problem], { "field-step": "yes" }));
    const edits = finding!.fix.kind === "auto" ? finding!.fix.edits : [];
    const config = applyEdits(readFileOrUndefined(p.configFile) ?? "", edits.filter((e) => e.file === p.configFile)).text;
    expect(config).toContain('anonymousFields: { settings: ["id"], media: ["id"');
  });

  it("stays manual on a manual answer, and for a pipeline whose resource it cannot tell", async () => {
    const [manual] = await fieldStepRule.check(contextFor(await project(), [problem], { "field-step": "manual" }));
    expect(manual?.fix.kind).toBe("manual");
    const p = await project({ pipelines: [{ name: "custom", steps: ["authn.identifyUser", "custom.read"] }] });
    const [unknown] = await fieldStepRule.check(contextFor(p, [attachFailed([missingStepLine("custom", "item")])], { "field-step": "yes" }));
    expect(unknown?.fix.kind).toBe("manual");
    expect(unknown?.suggestion).toContain('custom: the resource of its answer');
  });

  it("does not fire without a field-step problem from authz-roles", async () => {
    expect(await fieldStepRule.check(contextFor(await project()))).toEqual([]);
    expect(await fieldStepRule.check(contextFor(await project(), [attachFailed(['authz/roles: pipeline "serveMediaFile" runs media.serve, whose output is also published without an access check, but anonymous callers lack "media.read"'])]))).toEqual([]);
  });
});

describe("authz/field-grant-unknown", () => {
  it("reports every other field problem as manual, with the hint boot gave", async () => {
    const lines = [
      'authz/roles: anonymousFields.media names "variants.path", which no pipeline ending with authz.fields:media declares – "variants" is a list, write "variants[].path"',
      'authz/roles: anonymousFields grants fields of "settings", but no pipeline ends with authz.fields:settings',
      'authz/roles: pipeline "getMedia" ends with authz.fields:media?shape=list, but its declared output is not a list ({ items, total }) – write authz.fields:media?shape=item',
      'authz/roles: pipeline "pageMenus" ends with authz.fields:menu?shape=item, but its declared output reads as a list ({ items, total }) and anonymousFields.menu names "id", which only its items declare – write authz.fields:menu?shape=list',
    ];
    const findings = await fieldGrantUnknownRule.check(contextFor(await project(), [attachFailed([missingStepLine("getMedia", "item"), ...lines])]));
    expect(findings.map((f) => f.message)).toEqual(lines);
    expect(findings.every((f) => f.fix.kind === "manual" && f.tier === "boot" && f.where.module === "authz/roles")).toBe(true);
    expect(findings[0]?.suggestion).toBe('"variants" is a list, write "variants[].path"');
  });
});

describe("responses/anonymous-fields", () => {
  it("lists each public read and the members anonymous callers stop receiving once it ends with the step", async () => {
    const triggers = [
      { http: "GET /media/:id", pipeline: "getMedia" },
      { http: "GET /site/*path", pipeline: "resolvePage" },
      { http: "GET /admin/media/:id", pipeline: "adminMedia" },
      { http: "GET /media/:id/:name", pipeline: "serveMediaFile" },
    ];
    const findings = await anonymousFieldsRule.check(contextFor(await project({ triggers })));
    expect(findings.map((f) => f.where.pipeline)).toEqual(["getMedia", "resolvePage", "serveMediaFile"]);
    expect(findings.every((f) => f.severity === "info")).toBe(true);
    expect(findings[0]?.message).toContain("folder, createdAt, updatedAt, available, variantCounts, variants[].bytes, variants[].state");
    expect(findings[1]?.message).toContain("createdAt, updatedAt");
    expect(findings[2]?.message).toContain("every response header the grant does not name");
  });

  it("reads anonymous grants from host-supplied defaults", async () => {
    const modules = MODULES.map((m) => (m.use === AUTHZ ? { use: m.use, config: {}, defaults: { from: "site-preset", values: m.config } } : m));
    const findings = await anonymousFieldsRule.check(contextFor(await project({ modules, triggers: [{ http: "GET /media/:id", pipeline: "getMedia" }] })));
    expect(findings.map((f) => f.where.pipeline)).toEqual(["getMedia"]);
  });

  it("stays silent without anonymous grants and for a pipeline that already ends with the step", async () => {
    const modules = MODULES.map((m) => (m.use === AUTHZ ? { ...m, config: { roles: {}, anonymous: [] } } : m));
    expect(await anonymousFieldsRule.check(contextFor(await project({ modules, triggers: [{ http: "GET /media/:id", pipeline: "getMedia" }] })))).toEqual([]);
    const pipelines = [{ name: "getMedia", steps: ["authn.identifyUser", "authz.require:media.read", "media.get", "authz.fields:media?shape=item"] }];
    expect(await anonymousFieldsRule.check(contextFor(await project({ pipelines, triggers: [{ http: "GET /media/:id", pipeline: "getMedia" }] })))).toEqual([]);
  });
});

describe("responses/thrown-error-text", () => {
  it("names a local module file that matches on the text of an error answer", async () => {
    await mkdir(join(dir, "modules"), { recursive: true });
    const moduleFile = join(dir, "modules", "notes.ts");
    await writeFile(moduleFile, "export default defineModule({ name: \"notes/local\" });\n");
    await writeFile(join(dir, "modules", "notes.test.ts"), 'expect(res.error).toContain("db down");\n');
    await writeFile(join(dir, "modules", "other.ts"), "export const x = 1;\n");
    const findings = await thrownErrorTextRule.check(contextFor(await project({ moduleFiles: { "notes/local": moduleFile } })));
    expect(findings.map((f) => f.where.file)).toEqual([join(dir, "modules", "notes.test.ts")]);
    expect(findings[0]).toMatchObject({ rule: "responses/thrown-error-text", severity: "info" });
  });

  it("never scans an installed package's own directory, reached through a pnpm-style node_modules layout", async () => {
    const pkgDir = join(dir, "node_modules", ".pnpm", "@michaelthielemann+kestrel-events-direct@6.0.0", "node_modules", "@michaelthielemann", "kestrel-events-direct");
    await mkdir(pkgDir, { recursive: true });
    const moduleFile = join(pkgDir, "dist", "index.js");
    await mkdir(dirname(moduleFile), { recursive: true });
    await writeFile(moduleFile, "exports.default = { name: \"events/direct\" };\n");
    await writeFile(join(pkgDir, "dist", "index.test.js"), 'expect(res.error).toContain("db down");\n');
    const findings = await thrownErrorTextRule.check(contextFor(await project({ moduleFiles: { "events/direct": moduleFile } })));
    expect(findings).toEqual([]);
  });
});

describe("responses/breaking-step-shapes", () => {
  it("names narrows among insights.readManifest's changes", async () => {
    const findings = await breakingStepShapesRule.check(contextFor(await project({ pipelines: [{ name: "insightsManifest", steps: ["authn.requireUser", "insights.readManifest"] }] })));
    expect(findings[0]?.message).toContain("narrows");
  });
});
