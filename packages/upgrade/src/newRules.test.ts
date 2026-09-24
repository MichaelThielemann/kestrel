import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { BootCheck, BootProblem, BootWarning, ModuleDefinition, PipelineDefinition } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import { findCalls, firstArgument, isArrayExpression, objectProperty } from "./ast.ts";
import type { ModelFieldsLocator, StepListLocator } from "./edits.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { readFileOrUndefined } from "./rules.ts";
import { breakingStepShapesRule, busHandlerThrowsRule, busSubscriberQueueRule, ctxDoneTerminalOutputRule, deliveryMembersRule, restoreFreshnessRule, runPipelineValidatesRule, typeSignaturesRule } from "./ruleInfo.ts";
import { emitsRule, eventPayloadRule } from "./ruleEmitsEvents.ts";
import { dependencyCycleRule, optionalReadOrderRule, outputFoldRule, terminalOutputRule, undeclaredOutputRule, undeclaredRequiredRule } from "./ruleBootWraps.ts";
import { underscoreFieldRule } from "./ruleUnderscoreField.ts";
import { verifiedUserRule } from "./ruleVerifiedUser.ts";

function fakeModule(name: string, emits: readonly string[] = []): ModuleDefinition {
  return { name, provides: [], requires: [], emits, configSchema: z.object({}), async setup() { return {}; } };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-newrules-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function bootCheck(errors: BootProblem[] = [], warnings: BootWarning[] = []): BootCheck {
  return { errors, warnings, notChecked: [] };
}

function contextFor(project: LoadedProject, options: { check?: BootCheck; answers?: ReadonlyMap<string, string>; data?: Record<string, unknown>; locateSteps?: StepListLocator; locateModelFields?: ModelFieldsLocator } = {}): RuleContext {
  const withData = options.data === undefined ? project : { ...project, data: options.data };
  return {
    root: dir,
    scratch: dir,
    project: withData,
    bootCheck: options.check ?? bootCheck(),
    readFile: readFileOrUndefined,
    answers: options.answers ?? new Map(),
    ownsPackages: [],
    ...(options.locateSteps === undefined ? {} : { locateSteps: options.locateSteps }),
    ...(options.locateModelFields === undefined ? {} : { locateModelFields: options.locateModelFields }),
  };
}

async function project(options: { configModules?: Array<{ use: string; config?: Record<string, unknown> }>; triggers?: unknown[]; pipelines?: PipelineDefinition[]; pipelineFiles?: Record<string, string>; modules?: ModuleDefinition[]; moduleFiles?: Record<string, string> }): Promise<LoadedProject> {
  const configFile = join(dir, "kestrel.config.ts");
  await writeFile(configFile, "export default defineConfig({});\n");
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: { config: { modules: options.configModules ?? [], triggers: (options.triggers ?? []) as never }, modules: options.modules ?? [], pipelines: options.pipelines ?? [] },
    kind: "backend",
    configFile,
    moduleFiles: new Map(Object.entries(options.moduleFiles ?? {})),
    pipelineFiles: new Map(Object.entries(options.pipelineFiles ?? {})),
  };
}

describe("pipelines/verified-user", () => {
  it("auto-inserts authn.verifyUser:reassignTo for an http-only pipeline with authn-multi", async () => {
    const file = join(dir, "retry.ts");
    const source = 'definePipeline({ name: "retry", steps: ["authn.requireUser", "revisions.reassignAuthor"] });\n';
    await writeFile(file, source);
    const p = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /retry", pipeline: "retry" }],
      pipelines: [{ name: "retry", steps: ["authn.requireUser", "revisions.reassignAuthor"] }],
      pipelineFiles: { retry: file },
    });
    const findings = await verifiedUserRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain('"authn.verifyUser:reassignTo", "revisions.reassignAuthor"');
  });

  it("edits a plugin project's own pipeline layout through ctx.locateSteps", async () => {
    const file = join(dir, "retry.ts");
    const source = 'defineFlow({ id: "retry", options: { steps: ["authn.requireUser", "revisions.reassignAuthor"] } });\n';
    await writeFile(file, source);
    const p = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /retry", pipeline: "retry" }],
      pipelines: [{ name: "retry", steps: ["authn.requireUser", "revisions.reassignAuthor"] }],
      pipelineFiles: { retry: file },
    });
    const locateSteps: StepListLocator = (root, pipelineName) => {
      for (const call of findCalls(root, "defineFlow")) {
        const arg = firstArgument(call);
        if (arg?.type !== "ObjectExpression" || objectProperty(arg, "id")?.value !== pipelineName) continue;
        const options = objectProperty(arg, "options");
        const steps = options?.type === "ObjectExpression" ? objectProperty(options, "steps") : undefined;
        if (isArrayExpression(steps)) return [steps];
      }
      return [];
    };
    const findings = await verifiedUserRule.check(contextFor(p, { locateSteps }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain('"authn.verifyUser:reassignTo", "revisions.reassignAuthor"');
  });

  it("inserts after authn.requireUser and authz.require, never before them, when several steps share one line", async () => {
    const file = join(dir, "reassign.ts");
    const source = `definePipeline({
  name: "reassign",
  steps: [
    "authn.requireUser", "authz.require:users.manage", "revisions.reassignAuthor",
  ],
});
`;
    await writeFile(file, source);
    const p = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /admin/users/:id/revisions/reassign", pipeline: "reassign" }],
      pipelines: [{ name: "reassign", steps: ["authn.requireUser", "authz.require:users.manage", "revisions.reassignAuthor"] }],
      pipelineFiles: { reassign: file },
    });
    const findings = await verifiedUserRule.check(contextFor(p));
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text.indexOf('"authn.requireUser"')).toBeLessThan(text.indexOf("authn.verifyUser:reassignTo"));
    expect(text.indexOf("authz.require")).toBeLessThan(text.indexOf("authn.verifyUser:reassignTo"));
    expect(text.indexOf("authn.verifyUser:reassignTo")).toBeLessThan(text.indexOf("revisions.reassignAuthor"));
  });

  it("asks when a pipeline has both http and event triggers", async () => {
    const p = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /retry", pipeline: "retry" }, { event: "revision.retry", pipeline: "retry" }],
      pipelines: [{ name: "retry", steps: ["revisions.reassignAuthor"] }],
    });
    const findings = await verifiedUserRule.check(contextFor(p));
    expect(findings[0]?.fix.kind).toBe("ask");
  });

  it("is manual without authn-multi", async () => {
    const p = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-single" }],
      triggers: [{ http: "POST /retry", pipeline: "retry" }],
      pipelines: [{ name: "retry", steps: ["revisions.reassignAuthor"] }],
    });
    const findings = await verifiedUserRule.check(contextFor(p));
    expect(findings[0]?.fix.kind).toBe("manual");
  });

  it("does not fire once authn.verifyUser already precedes the step", async () => {
    const p = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /retry", pipeline: "retry" }],
      pipelines: [{ name: "retry", steps: ["authn.verifyUser:reassignTo", "revisions.reassignAuthor"] }],
    });
    expect(await verifiedUserRule.check(contextFor(p))).toEqual([]);
  });
});

describe("steps/undeclared-output (boot wrap)", () => {
  it("asks binary:<module>.<step> and applies binary: true on yes", async () => {
    const file = join(dir, "notes.ts");
    const source = 'export default defineModule({ describe: () => ({ create: { summary: "x", reads: [], writes: ["result"] } }) });\n';
    await writeFile(file, source);
    const p = await project({ modules: [fakeModule("notes/local")], moduleFiles: { "notes/local": file } });
    const problem: BootProblem = { code: "undeclared-output", owner: "pipelines/p", reason: 'step "notes.create" writes result without declaring output', pipeline: "p", step: "notes.create" };
    const ctxAsk = contextFor(p, { check: bootCheck([problem]) });
    const asked = await undeclaredOutputRule.check(ctxAsk);
    expect(asked[0]?.fix.kind).toBe("ask");

    const ctxYes = contextFor(p, { check: bootCheck([problem]), answers: new Map([["binary:notes/local.create", "yes"]]) });
    const applied = await undeclaredOutputRule.check(ctxYes);
    expect(applied[0]?.fix.kind).toBe("auto");
    const edits = applied[0]!.fix.kind === "auto" ? applied[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain("binary: true");
  });
});

describe("steps/undeclared-required (boot wrap)", () => {
  it("asks required:<module>.<step>:<path> and applies the listed properties", async () => {
    const file = join(dir, "notes.ts");
    const source = 'export default defineModule({ describe: () => ({ create: { summary: "x", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } } } } }) });\n';
    await writeFile(file, source);
    const p = await project({ modules: [fakeModule("notes/local")], moduleFiles: { "notes/local": file } });
    const problem: BootProblem = { code: "undeclared-required", owner: "pipelines/p", reason: "declares properties without required", pipeline: "p", step: "notes.create", path: "$.output" };
    const ctxYes = contextFor(p, { check: bootCheck([problem]), answers: new Map([["required:notes/local.create:$.output", "id"]]) });
    const applied = await undeclaredRequiredRule.check(ctxYes);
    expect(applied[0]?.fix.kind).toBe("auto");
    const edits = applied[0]!.fix.kind === "auto" ? applied[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain('required: ["id"]');
  });

  it("has no default answer (a question without one)", async () => {
    const file = join(dir, "notes.ts");
    await writeFile(file, 'export default defineModule({ describe: () => ({ create: { summary: "x", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } } } } }) });\n');
    const p = await project({ modules: [fakeModule("notes/local")], moduleFiles: { "notes/local": file } });
    const problem: BootProblem = { code: "undeclared-required", owner: "pipelines/p", reason: "x", pipeline: "p", step: "notes.create", path: "$.output" };
    const findings = await undeclaredRequiredRule.check(contextFor(p, { check: bootCheck([problem]) }));
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : "n/a").toBeUndefined();
  });
});

describe("the generic boot wraps (output-fold, terminal-output, optional-read-order, dependency-cycle)", () => {
  it("steps/output-fold reports the boot error's own reason as a manual finding", async () => {
    const p = await project({});
    const problem: BootProblem = { code: "output-fold-contradiction", owner: "pipelines/p", reason: "step \"a.b\" folds a property two steps disagree on the type of", pipeline: "p", step: "a.b" };
    const findings = await outputFoldRule.check(contextFor(p, { check: bootCheck([problem]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.message).toBe(problem.reason);
    expect(findings[0]?.where.pipeline).toBe("p");
    expect(findings[0]?.docs).toBe("docs/upgrading.md#steps-output-fold");
  });

  it("steps/terminal-output reports terminal-output-misplaced as a manual finding", async () => {
    const p = await project({});
    const problem: BootProblem = { code: "terminal-output-misplaced", owner: "pipelines/p", reason: "step \"a.b\" is not last but writes the terminal output field", pipeline: "p", step: "a.b" };
    const findings = await terminalOutputRule.check(contextFor(p, { check: bootCheck([problem]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.message).toBe(problem.reason);
    expect(findings[0]?.docs).toBe("docs/upgrading.md#steps-terminal-output");
  });

  it("pipelines/optional-read-order reports optional-read-order as a manual finding", async () => {
    const p = await project({});
    const problem: BootProblem = { code: "optional-read-order", owner: "pipelines/p", reason: "step \"a.b\" optionally reads a key no earlier step writes or a trigger provides", pipeline: "p", step: "a.b" };
    const findings = await optionalReadOrderRule.check(contextFor(p, { check: bootCheck([problem]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.message).toBe(problem.reason);
    expect(findings[0]?.docs).toBe("docs/upgrading.md#pipelines-optional-read-order");
  });

  it("boot/dependency-cycle reports dependency-cycle as a manual finding", async () => {
    const p = await project({});
    const problem: BootProblem = { code: "dependency-cycle", owner: "a", module: "a", reason: "module dependency cycle: a -> b -> a" };
    const findings = await dependencyCycleRule.check(contextFor(p, { check: bootCheck([problem]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.message).toBe(problem.reason);
    expect(findings[0]?.where.module).toBe("a");
    expect(findings[0]?.docs).toBe("docs/upgrading.md#boot-dependency-cycle");
  });

  it("reports nothing when no boot error of its own code is present", async () => {
    const p = await project({});
    const ctx = contextFor(p, { check: bootCheck([{ code: "dependency-cycle", owner: "a", reason: "x" }]) });
    expect(await outputFoldRule.check(ctx)).toEqual([]);
    expect(await terminalOutputRule.check(ctx)).toEqual([]);
    expect(await optionalReadOrderRule.check(ctx)).toEqual([]);
  });
});

describe("types/breaking-signatures", () => {
  it("always fires, regardless of the project", async () => {
    const empty = await project({});
    const findings = await typeSignaturesRule.check(contextFor(empty));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.fix.kind).toBe("none");
    expect(findings[0]?.docs).toBe("docs/upgrading.md#types-breaking-signatures");

    const full = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /x", pipeline: "p" }],
      pipelines: [{ name: "p", steps: ["authn.requireUser"] }],
    });
    expect(await typeSignaturesRule.check(contextFor(full))).toEqual(findings);
  });
});

describe("model/underscore-field", () => {
  it("asks with no default when no data report was given", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : "n/a").toBeUndefined();
  });

  it("points at kestrel-upgrade data when no data report was given", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestion).toMatch(/kestrel-upgrade data/);
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.prompt : "n/a").toMatch(/kestrel-upgrade data/);
  });

  it("asks with no default and reports the counts when the data report counted a stored value", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { unlocalized: 3 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : "n/a").toBeUndefined();
    expect(findings[0]?.message).toContain("3 stored value(s)");
  });

  it("asks and reports counts per locale for a localized field with some stored values", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string", localized: true } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { de: 2, en: 0 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.message).toContain('2 in "de"');
  });

  it("auto-renames once the data report counts zero everywhere", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }], triggers: [] });\n';
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    await writeFile(p.configFile, source);
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { unlocalized: 0 } } } }));
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain("fields: { hint:");
  });

  it("edits a plugin project's own content-model layout through ctx.locateModelFields", async () => {
    const source = 'defineContentModel({ name: "page", schema: { fields: { _hint: { type: "string" }, title: { type: "string" } } } });\n';
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    await writeFile(p.configFile, source);
    const locateModelFields: ModelFieldsLocator = (root, { typeName }) => {
      for (const call of findCalls(root, "defineContentModel")) {
        const arg = firstArgument(call);
        if (arg?.type !== "ObjectExpression" || objectProperty(arg, "name")?.value !== typeName) continue;
        const schema = objectProperty(arg, "schema");
        const fields = schema?.type === "ObjectExpression" ? objectProperty(schema, "fields") : undefined;
        if (fields?.type === "ObjectExpression") return fields;
      }
      return undefined;
    };
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { unlocalized: 0 } } }, locateModelFields }));
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain("fields: { hint:");
  });

  it("auto-renames once every locale of a localized field counts zero", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string", localized: true } } } } } }], triggers: [] });\n';
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string", localized: true } } } } } }] });
    await writeFile(p.configFile, source);
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { de: 0, en: 0 } } } }));
    expect(findings[0]?.fix.kind).toBe("auto");
  });

  it("keeps an explicit rename answer without a proving count as a visible warning", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }], triggers: [] });\n';
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    await writeFile(p.configFile, source);
    const answers = new Map([["underscore-field:page._hint", "hint"]]);
    const findings = await underscoreFieldRule.check(contextFor(p, { answers }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.fix.kind).toBe("auto");
    expect(findings[0]?.suggestion).toMatch(/no data report was supplied/);
  });

  it("stops warning once a data report proves the field empty, even for a custom rename target", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }], triggers: [] });\n';
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    await writeFile(p.configFile, source);
    const answers = new Map([["underscore-field:page._hint", "renamedHint"]]);
    const findings = await underscoreFieldRule.check(contextFor(p, { answers, data: { underscoreFields: { "page._hint": { unlocalized: 0 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain("fields: { renamedHint:");
  });

  it("keeps warning about an orphaned old column after the rename has already been written to the config", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { unlocalized: 2 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.fix.kind).toBe("none");
    expect(findings[0]?.message).toContain('"_hint"');
    expect(findings[0]?.message).toContain("2 stored value(s)");
  });

  it("keeps warning about the orphaned old column when it could not be counted", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { unlocalized: null } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("stops warning about the orphaned old column once a data report counts it empty", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { unlocalized: 0 } } } }));
    expect(findings).toEqual([]);
  });

  it("stays silent about a regular field with no data-report entry for an old column", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } } }] });
    expect(await underscoreFieldRule.check(contextFor(p))).toEqual([]);
    expect(await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: {} } }))).toEqual([]);
  });

  it("does not treat a declared underscore field as an orphan of a same-named regular field", async () => {
    const p = await project({
      configModules: [
        { use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" }, hint: { type: "string" } } } } } },
      ],
    });
    const findings = await underscoreFieldRule.check(contextFor(p, { data: { underscoreFields: { "page._hint": { unlocalized: 3 } } } }));
    expect(findings.filter((f) => f.message.includes("current field is named"))).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where.path).toBe("types.page.fields._hint");
  });
});

describe("modules/emits", () => {
  it("asks which events a module raises from setup(), heuristically finding .emit( calls", async () => {
    const file = join(dir, "migrations.ts");
    await writeFile(file, 'export default defineModule({ name: "migrations/default", async setup(config, deps) { await deps.get(EVENTS).emit("migrations.applied", {}); return {}; } });\n');
    const p = await project({ modules: [fakeModule("migrations/default")], moduleFiles: { "migrations/default": file } });
    const findings = await emitsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
  });

  it("does not fire once the event is already declared", async () => {
    const file = join(dir, "migrations.ts");
    await writeFile(file, 'export default defineModule({ async setup(config, deps) { await deps.get(EVENTS).emit("migrations.applied", {}); return {}; } });\n');
    const p = await project({ modules: [fakeModule("migrations/default", ["migrations.applied"])], moduleFiles: { "migrations/default": file } });
    expect(await emitsRule.check(contextFor(p))).toEqual([]);
  });
});

describe("steps/closed-event-input", () => {
  it("reports a closed input schema on a step used by an event-triggered pipeline", async () => {
    const file = join(dir, "notes.ts");
    await writeFile(file, 'export default defineModule({ describe: () => ({ create: { summary: "x", reads: [], writes: [], input: { type: "object", additionalProperties: false, properties: { title: { type: "string" } } } } }) });\n');
    const p = await project({
      triggers: [{ event: "note.created", pipeline: "onNote" }],
      pipelines: [{ name: "onNote", steps: ["notes.create"] }],
      moduleFiles: { "notes/local": file },
    });
    const findings = await eventPayloadRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
  });

  it("does not fire for a step not used on an event trigger", async () => {
    const file = join(dir, "notes.ts");
    await writeFile(file, 'export default defineModule({ describe: () => ({ create: { summary: "x", reads: [], writes: [], input: { type: "object", additionalProperties: false, properties: {} } } }) });\n');
    const p = await project({ triggers: [], pipelines: [], moduleFiles: { "notes/local": file } });
    expect(await eventPayloadRule.check(contextFor(p))).toEqual([]);
  });
});

describe("info rules", () => {
  it("responses/delivery-members fires for an HTTP pipeline running a delivery step", async () => {
    const p = await project({ triggers: [{ http: "POST /pages", pipeline: "createPage" }], pipelines: [{ name: "createPage", steps: ["delivery.publish:pages"] }] });
    const findings = await deliveryMembersRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.message).toContain("merges { document, delivery } into _delivery");
    expect(findings[0]?.message).toContain("writes _llms instead of llms");
  });

  it("runtime/bus-handler-throws fires when events-direct is configured and a module subscribes with .on(", async () => {
    const file = join(dir, "audit.ts");
    await writeFile(file, 'bus.on("page.created", async () => {});\n');
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-events-direct" }], moduleFiles: { "audit/local": file } });
    expect(await busHandlerThrowsRule.check(contextFor(p))).toHaveLength(1);
  });

  it("runtime/bus-subscriber-queue fires only when the subscribed event is also an event trigger", async () => {
    const file = join(dir, "audit.ts");
    await writeFile(file, 'bus.on("page.created", async () => {});\n');
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-events-queue" }], triggers: [{ event: "page.created", pipeline: "onCreated" }], moduleFiles: { "audit/local": file } });
    expect(await busSubscriberQueueRule.check(contextFor(p))).toHaveLength(1);
  });

  it("tests/run-pipeline-validates fires for a file importing testing/runPipeline", async () => {
    const file = join(dir, "module.test.ts");
    await writeFile(file, 'import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";\n');
    const p = await project({ moduleFiles: { "notes/local": file } });
    expect(await runPipelineValidatesRule.check(contextFor(p))).toHaveLength(1);
  });

  it("runtime/restore-freshness fires when restoreOnStart defaults on", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-replication-sqlite" }] });
    expect(await restoreFreshnessRule.check(contextFor(p))).toHaveLength(1);
  });

  it("runtime/restore-freshness stays quiet when restoreOnStart is off", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-replication-sqlite", config: { restoreOnStart: false } }] });
    expect(await restoreFreshnessRule.check(contextFor(p))).toEqual([]);
  });

  it("types/breaking-signatures names Manifest.warnings and Kestrel contracts", async () => {
    const p = await project({});
    const findings = await typeSignaturesRule.check(contextFor(p));
    expect(findings[0]?.message).toContain("Manifest.warnings");
    expect(findings[0]?.message).toContain('Kestrel["contracts"].names()');
  });

  it("responses/breaking-step-shapes fires once per matching step, each with its own message", async () => {
    const p = await project({ pipelines: [{ name: "resolveLink", steps: ["redirects.lookup:x"] }, { name: "upload", steps: ["media.upload:y"] }] });
    const findings = await breakingStepShapesRule.check(contextFor(p));
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.where.step === "redirects.lookup")?.message).toContain("terminalOutput");
    expect(findings.find((f) => f.where.step === "media.upload")?.message).toContain("_events");
  });

  it("responses/breaking-step-shapes fires for events.listDead and insights.readManifest too", async () => {
    const p = await project({ pipelines: [{ name: "admin", steps: ["events.listDead:x", "insights.readManifest"] }] });
    const findings = await breakingStepShapesRule.check(contextFor(p));
    expect(findings.map((f) => f.where.step).sort()).toEqual(["events.listDead", "insights.readManifest"]);
  });

  it("responses/breaking-step-shapes stays quiet for a pipeline using none of these steps", async () => {
    const p = await project({ pipelines: [{ name: "createPage", steps: ["content.create"] }] });
    expect(await breakingStepShapesRule.check(contextFor(p))).toEqual([]);
  });

  it("steps/ctx-done-terminal-output fires for a local module calling ctx.done(", async () => {
    const file = join(dir, "notes.ts");
    await writeFile(file, 'steps: () => ({ create: async (ctx) => ctx.done({ id: "x" }) })\n');
    const p = await project({ moduleFiles: { "notes/local": file } });
    const findings = await ctxDoneTerminalOutputRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("terminalOutput");
  });

  it("steps/ctx-done-terminal-output stays quiet for a module that never calls ctx.done(", async () => {
    const file = join(dir, "notes.ts");
    await writeFile(file, 'steps: () => ({ create: async (ctx) => ok(ctx) })\n');
    const p = await project({ moduleFiles: { "notes/local": file } });
    expect(await ctxDoneTerminalOutputRule.check(contextFor(p))).toEqual([]);
  });
});
