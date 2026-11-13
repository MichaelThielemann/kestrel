import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { BootCheck, BootProblem, BootWarning, ModuleDefinition, PipelineDefinition } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import { findCalls, firstArgument, isArrayExpression, objectProperty } from "./ast.ts";
import type { ModelFieldsLocator, StepListLocator } from "./edits.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { upgradingDocs } from "./ruleHelpers.ts";
import { readFileOrUndefined } from "./rules.ts";
import { breakingStepShapesRule, busHandlerThrowsRule, busSubscriberQueueRule, ctxDoneTerminalOutputRule, deliveryDependentsRule, deliveryMembersRule, restoreFreshnessRule, runPipelineValidatesRule, trustedProxiesRule, typeSignaturesRule } from "./ruleInfo.ts";
import { emitsRule, eventPayloadRule } from "./ruleEmitsEvents.ts";
import { dependencyCycleRule, optionalReadOrderRule, outputFoldRule, terminalOutputRule, undeclaredOutputRule, undeclaredRequiredRule } from "./ruleBootWraps.ts";
import { underscoreFieldRule } from "./ruleUnderscoreField.ts";
import { verifiedUserRule } from "./ruleVerifiedUser.ts";
import { mediaListRule } from "./ruleMediaList.ts";
import { requireRoleRule } from "./ruleRequireRole.ts";

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

function contextFor(project: LoadedProject, options: { check?: BootCheck; answers?: ReadonlyMap<string, string>; dataReport?: Record<string, unknown>; locateSteps?: StepListLocator; locateModelFields?: ModelFieldsLocator } = {}): RuleContext {
  const withData = options.dataReport === undefined ? project : { ...project, dataReport: options.dataReport };
  return {
    root: dir,
    scratch: dir,
    project: withData,
    bootCheck: options.check ?? bootCheck(),
    readFile: readFileOrUndefined,
    answers: options.answers ?? new Map(),
    ...(options.locateSteps === undefined ? {} : { locateSteps: options.locateSteps }),
    ...(options.locateModelFields === undefined ? {} : { locateModelFields: options.locateModelFields }),
  };
}

async function project(options: { configModules?: Array<{ use: string; config?: Record<string, unknown>; defaults?: { from: string; values: Record<string, unknown> } }>; triggers?: unknown[]; pipelines?: PipelineDefinition[]; pipelineFiles?: Record<string, string>; modules?: ModuleDefinition[]; moduleFiles?: Record<string, string> }): Promise<LoadedProject> {
  const configFile = join(dir, "kestrel.config.ts");
  await writeFile(configFile, "export default defineConfig({});\n");
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: { config: { modules: options.configModules ?? [], triggers: (options.triggers ?? []) as never }, modules: options.modules ?? [], pipelines: options.pipelines ?? [] },
    kind: "backend",
    configFile,
    moduleFiles: new Map(Object.entries(options.moduleFiles ?? {})),
    pipelineFiles: Object.entries(options.pipelineFiles ?? {}).map(([name, file]) => ({ file, pipelines: [name] })),
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

  it("resolves the right pipeline's file among several PipelineFile entries, not just the first one", async () => {
    const decoyFile = join(dir, "other.ts");
    await writeFile(decoyFile, 'export default definePipeline({ name: "other", steps: ["content.create"] });\n');
    const file = join(dir, "retry.ts");
    const source = 'export default definePipeline({ name: "retry", steps: ["authn.requireUser", "revisions.reassignAuthor"] });\n';
    await writeFile(file, source);
    const p: LoadedProject = {
      input: {
        config: { modules: [{ use: "@michaelthielemann/kestrel-authn-multi" }], triggers: [{ http: "POST /retry", pipeline: "retry" }] },
        modules: [],
        pipelines: [
          { name: "other", steps: ["content.create"] },
          { name: "retry", steps: ["authn.requireUser", "revisions.reassignAuthor"] },
        ],
      },
      kind: "backend",
      configFile: join(dir, "kestrel.config.ts"),
      moduleFiles: new Map(),
      pipelineFiles: [
        { file: decoyFile, pipelines: ["other"] },
        { file, pipelines: ["retry"] },
      ],
    };
    const findings = await verifiedUserRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    expect(edits.every((e) => e.file === file)).toBe(true);
    const { text } = applyEdits(source, edits);
    expect(text).toContain('"authn.verifyUser:reassignTo", "revisions.reassignAuthor"');
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

  it('choosing the listed "split manually" choice goes manual instead of inserting a bogus authn.verifyUser:split manually step', async () => {
    const file = join(dir, "retry.ts");
    const source = 'definePipeline({ name: "retry", steps: ["revisions.reassignAuthor"] });\n';
    await writeFile(file, source);
    const ambiguousProject = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /retry", pipeline: "retry" }, { event: "revision.retry", pipeline: "retry" }],
      pipelines: [{ name: "retry", steps: ["revisions.reassignAuthor"] }],
      pipelineFiles: { retry: file },
    });
    const findings = await verifiedUserRule.check(contextFor(ambiguousProject, { answers: new Map([["verified-user-path:retry", "split manually"]]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(readFileOrUndefined(file)).toBe(source);
  });

  it('choosing "other" also goes manual, instead of leaving the question open forever', async () => {
    const file = join(dir, "retry.ts");
    const source = 'definePipeline({ name: "retry", steps: ["revisions.reassignAuthor"] });\n';
    await writeFile(file, source);
    const ambiguousProject = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /retry", pipeline: "retry" }, { event: "revision.retry", pipeline: "retry" }],
      pipelines: [{ name: "retry", steps: ["revisions.reassignAuthor"] }],
      pipelineFiles: { retry: file },
    });
    const findings = await verifiedUserRule.check(contextFor(ambiguousProject, { answers: new Map([["verified-user-path:retry", "other"]]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(readFileOrUndefined(file)).toBe(source);
  });

  it("marks the question's choices as closed, so a custom answer outside them is never written as a literal path", async () => {
    const file = join(dir, "retry.ts");
    const source = 'definePipeline({ name: "retry", steps: ["revisions.reassignAuthor"] });\n';
    await writeFile(file, source);
    const ambiguousProject = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-authn-multi" }],
      triggers: [{ http: "POST /retry", pipeline: "retry" }, { event: "revision.retry", pipeline: "retry" }],
      pipelines: [{ name: "retry", steps: ["revisions.reassignAuthor"] }],
      pipelineFiles: { retry: file },
    });
    const findings = await verifiedUserRule.check(contextFor(ambiguousProject, {}));
    const fix = findings[0]?.fix;
    expect(fix?.kind).toBe("ask");
    expect(fix?.kind === "ask" ? fix.closedChoices : undefined).toBe(true);
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

  it('answering "all" declares every property the schema actually lists as required, not none', async () => {
    const file = join(dir, "notes.ts");
    const source = 'export default defineModule({ describe: () => ({ create: { summary: "x", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } } } }) });\n';
    await writeFile(file, source);
    const p = await project({ modules: [fakeModule("notes/local")], moduleFiles: { "notes/local": file } });
    const problem: BootProblem = { code: "undeclared-required", owner: "pipelines/p", reason: "declares properties without required", pipeline: "p", step: "notes.create", path: "$.output" };
    const ctxAll = contextFor(p, { check: bootCheck([problem]), answers: new Map([["required:notes/local.create:$.output", "all"]]) });
    const applied = await undeclaredRequiredRule.check(ctxAll);
    expect(applied[0]?.fix.kind).toBe("auto");
    const edits = applied[0]!.fix.kind === "auto" ? applied[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain('required: ["id", "title"]');
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

  it('answering "all" reports why, instead of silently making no edit, when the step is a factory this cannot locate', async () => {
    const file = join(dir, "notes.ts");
    const source =
      'function buildDescribe() { return { create: { summary: "x", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } } } } }; }\nexport default defineModule({ describe: buildDescribe });\n';
    await writeFile(file, source);
    const p = await project({ modules: [fakeModule("notes/local")], moduleFiles: { "notes/local": file } });
    const problem: BootProblem = { code: "undeclared-required", owner: "pipelines/p", reason: "declares properties without required", pipeline: "p", step: "notes.create", path: "$.output" };
    const ctxAll = contextFor(p, { check: bootCheck([problem]), answers: new Map([["required:notes/local.create:$.output", "all"]]) });
    const findings = await undeclaredRequiredRule.check(ctxAll);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.message).toBe(problem.reason);
    expect(findings[0]?.suggestion).toContain('"all"');
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
    expect(findings[0]?.docs).toBe(upgradingDocs("steps-output-fold"));
  });

  it("steps/terminal-output reports terminal-output-misplaced as a manual finding", async () => {
    const p = await project({});
    const problem: BootProblem = { code: "terminal-output-misplaced", owner: "pipelines/p", reason: "step \"a.b\" is not last but writes the terminal output field", pipeline: "p", step: "a.b" };
    const findings = await terminalOutputRule.check(contextFor(p, { check: bootCheck([problem]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.message).toBe(problem.reason);
    expect(findings[0]?.docs).toBe(upgradingDocs("steps-terminal-output"));
  });

  it("pipelines/optional-read-order reports optional-read-order as a manual finding", async () => {
    const p = await project({});
    const problem: BootProblem = { code: "optional-read-order", owner: "pipelines/p", reason: "step \"a.b\" optionally reads a key no earlier step writes or a trigger provides", pipeline: "p", step: "a.b" };
    const findings = await optionalReadOrderRule.check(contextFor(p, { check: bootCheck([problem]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.message).toBe(problem.reason);
    expect(findings[0]?.docs).toBe(upgradingDocs("pipelines-optional-read-order"));
  });

  it("boot/dependency-cycle reports dependency-cycle as a manual finding", async () => {
    const p = await project({});
    const problem: BootProblem = { code: "dependency-cycle", owner: "a", module: "a", reason: "module dependency cycle: a -> b -> a" };
    const findings = await dependencyCycleRule.check(contextFor(p, { check: bootCheck([problem]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.message).toBe(problem.reason);
    expect(findings[0]?.where.module).toBe("a");
    expect(findings[0]?.docs).toBe(upgradingDocs("boot-dependency-cycle"));
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
    expect(findings[0]?.docs).toBe(upgradingDocs("types-breaking-signatures"));

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

  it("finds an underscore field declared only in host-supplied defaults", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: {}, defaults: { from: "site-preset", values: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where.path).toBe("types.page.fields._hint");
  });

  it("points at kestrel upgrade data when no data report was given", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestion).toMatch(/kestrel upgrade data/);
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.prompt : "n/a").toMatch(/kestrel upgrade data/);
  });

  it("asks with no default and reports the counts when the data report counted a stored value", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 3 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : "n/a").toBeUndefined();
    expect(findings[0]?.message).toContain("3 stored value(s)");
  });

  it("asks and reports counts per locale for a localized field with some stored values", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string", localized: true } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { de: 2, en: 0 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.message).toContain('2 in "de"');
  });

  it("auto-renames once the data report counts zero everywhere", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }], triggers: [] });\n';
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } }] });
    await writeFile(p.configFile, source);
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 0 } } } }));
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
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 0 } } }, locateModelFields }));
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain("fields: { hint:");
  });

  it("auto-renames once every locale of a localized field counts zero", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string", localized: true } } } } } }], triggers: [] });\n';
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string", localized: true } } } } } }] });
    await writeFile(p.configFile, source);
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { de: 0, en: 0 } } } }));
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
    const findings = await underscoreFieldRule.check(contextFor(p, { answers, dataReport: { underscoreFields: { "page._hint": { unlocalized: 0 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain("fields: { renamedHint:");
  });

  it("keeps warning about an orphaned old column after the rename has already been written to the config", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 2 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.fix.kind).toBe("none");
    expect(findings[0]?.message).toContain('"_hint"');
    expect(findings[0]?.message).toContain("2 stored value(s)");
  });

  it("keeps warning about the orphaned old column when it could not be counted", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { unlocalized: null } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("stops warning about the orphaned old column once a data report counts it empty", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } } }] });
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 0 } } } }));
    expect(findings).toEqual([]);
  });

  it("stays silent about a regular field with no data-report entry for an old column", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } } }] });
    expect(await underscoreFieldRule.check(contextFor(p))).toEqual([]);
    expect(await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: {} } }))).toEqual([]);
  });

  it("does not treat a declared underscore field as an orphan of a same-named regular field", async () => {
    const p = await project({
      configModules: [
        { use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" }, hint: { type: "string" } } } } } },
      ],
    });
    const findings = await underscoreFieldRule.check(contextFor(p, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 3 } } } }));
    expect(findings.filter((f) => f.message.includes("current field is named"))).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where.path).toBe("types.page.fields._hint");
  });

  it("reads a plugin-supplied contentModel directly, with no content-default module in the project's own module list", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "custom-content", config: { types: { page: { fields: { _hint: { type: "string" } } } } } }], triggers: [] });\n';
    const p = await project({});
    await writeFile(p.configFile, source);
    const contentModel = { use: "custom-content", types: { page: { fields: { _hint: {} } } } };
    const findings = await underscoreFieldRule.check(contextFor({ ...p, contentModel }, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 0 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where.module).toBe("custom-content");
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain("fields: { hint:");
  });

  it("still warns about an orphaned old column via a plugin-supplied contentModel", async () => {
    const p = await project({});
    const contentModel = { use: "custom-content", types: { page: { fields: { hint: {} } } } };
    const findings = await underscoreFieldRule.check(contextFor({ ...p, contentModel }, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 2 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.fix.kind).toBe("none");
    expect(findings[0]?.message).toContain('"_hint"');
    expect(findings[0]?.message).toContain("2 stored value(s)");
  });

  it("writes the rename into contentModel.file, not configFile, when the model lives in a separate file", async () => {
    const modelFile = join(dir, "content-model.ts");
    const modelSource = 'export default { modules: [{ use: "custom-content", config: { types: { page: { fields: { _hint: { type: "string" } } } } } }] };\n';
    await writeFile(modelFile, modelSource);
    const p = await project({});
    const contentModel = { use: "custom-content", file: modelFile, types: { page: { fields: { _hint: {} } } } };
    const findings = await underscoreFieldRule.check(contextFor({ ...p, contentModel }, { dataReport: { underscoreFields: { "page._hint": { unlocalized: 0 } } } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => e.file === modelFile)).toBe(true);
    const { text } = applyEdits(modelSource, edits);
    expect(text).toContain("fields: { hint:");
    const configText = readFileOrUndefined(p.configFile);
    expect(configText).not.toContain("hint");
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
    expect(findings[0]?.message).not.toContain("llms");
  });

  it("responses/delivery-members names the llms member a pipeline running delivery.exportLlms loses", async () => {
    const p = await project({ triggers: [{ http: "POST /admin/publish-all/pages", pipeline: "publishAllPages" }], pipelines: [{ name: "publishAllPages", steps: ["delivery.publishAll:pages", "delivery.exportLlms"] }] });
    const findings = await deliveryMembersRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("delivery.requestIndexes");
    expect(findings[0]?.message).toContain("no llms member");
    expect(findings[0]?.message).not.toContain("_delivery");
  });

  it("responses/delivery-members stays quiet for an HTTP pipeline running no delivery step with a changed response", async () => {
    const p = await project({ triggers: [{ http: "GET /admin/publish-status/pages/:id", pipeline: "pagePublishStatus" }], pipelines: [{ name: "pagePublishStatus", steps: ["delivery.readStatus:pages"] }] });
    expect(await deliveryMembersRule.check(contextFor(p))).toEqual([]);
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

  async function withHttp(http: unknown): Promise<LoadedProject> {
    const p = await project({});
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return { ...p, input: { ...p.input, config: { ...p.input.config, http: http as never } } };
  }

  it("http/trusted-proxies names a forwarding policy that relies on the loopback default", async () => {
    for (const http of [{ trustProxy: true }, { trustedHeader: "x-real-ip" }]) {
      const findings = await trustedProxiesRule.check(contextFor(await withHttp(http)));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("info");
      expect(findings[0]?.message).toContain("trustedProxies");
      expect(findings[0]?.docs).toBe(upgradingDocs("http-trusted-proxies"));
    }
  });

  it("http/trusted-proxies stays quiet without a forwarding policy or with trustedProxies set", async () => {
    for (const http of [undefined, null, {}, { trustProxy: false }, { trustProxy: true, trustedProxies: ["10.0.0.0/8"] }]) {
      expect(await trustedProxiesRule.check(contextFor(await withHttp(http)))).toEqual([]);
    }
  });

  it("runtime/restore-freshness fires when restoreOnStart defaults on", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-replication-sqlite" }] });
    expect(await restoreFreshnessRule.check(contextFor(p))).toHaveLength(1);
  });

  it("runtime/restore-freshness stays quiet when restoreOnStart is off", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-replication-sqlite", config: { restoreOnStart: false } }] });
    expect(await restoreFreshnessRule.check(contextFor(p))).toEqual([]);
  });

  const publishing = {
    triggers: [{ event: "page.updated", pipeline: "publishPage" }],
    pipelines: [{ name: "publishPage", steps: ["delivery.publish:pages", "delivery.exportLlms"] }],
  };

  it("delivery/dependents stays quiet without delivery-static or without event-triggered publishing", async () => {
    expect(await deliveryDependentsRule.check(contextFor(await project(publishing)))).toEqual([]);
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-delivery-static" }], triggers: [{ http: "POST /publish", pipeline: "publishPage" }], pipelines: publishing.pipelines });
    expect(await deliveryDependentsRule.check(contextFor(p))).toEqual([]);
  });

  it("delivery/dependents names the missing marking and recovery pass of a delivery-static project that publishes on events", async () => {
    const p = await project({ configModules: [{ use: "@michaelthielemann/kestrel-delivery-static" }], ...publishing });
    const findings = await deliveryDependentsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.docs).toBe(upgradingDocs("delivery-dependents"));
    expect(findings[0]?.message).toContain("delivery.markDependents");
    expect(findings[0]?.message).toContain("delivery.resumeStale");
  });

  it("delivery/dependents names a render \"events\" configuration without its job trigger", async () => {
    const p = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { dependencies: { render: "events" } } }],
      triggers: [...publishing.triggers, { event: "page.updated", pipeline: "pageDependents" }, { cron: "*/5 * * * *", pipeline: "resumeStalePages" }],
      pipelines: [...publishing.pipelines, { name: "pageDependents", steps: ["delivery.markDependents:pages"] }, { name: "resumeStalePages", steps: ["delivery.resumeStale"] }],
    });
    const findings = await deliveryDependentsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("delivery.outputStale");
    expect(findings[0]?.message).not.toContain("delivery.resumeStale");
  });

  it("delivery/dependents stays quiet for a complete wiring", async () => {
    const p = await project({
      configModules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { dependencies: { render: "events" } } }],
      triggers: [...publishing.triggers, { event: "page.updated", pipeline: "pageDependents" }, { cron: "*/5 * * * *", pipeline: "resumeStalePages" }, { event: "delivery.outputStale", pipeline: "republishOutput" }],
      pipelines: [...publishing.pipelines, { name: "pageDependents", steps: ["delivery.markDependents:pages"] }, { name: "resumeStalePages", steps: ["delivery.resumeStale"] }, { name: "republishOutput", steps: ["delivery.republishOutput"] }],
    });
    expect(await deliveryDependentsRule.check(contextFor(p))).toEqual([]);
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

  it("types/breaking-signatures names what reading media through media@1 changed", async () => {
    const findings = await typeSignaturesRule.check(contextFor(await project({})));
    for (const part of ["createImages takes deps.media", "Media extends MediaFiles", "MediaStatus gained removing", "images-default's Config lost media"]) expect(findings[0]?.message).toContain(part);
  });

  it("types/breaking-signatures names what the media trash changed", async () => {
    const findings = await typeSignaturesRule.check(contextFor(await project({})));
    for (const part of ["MediaStatus gained trashed", "MediaItem gained trashedAt and trashVersion, and its location may be null", "Media gained trash, trashFolder, restore, listTrash, trashIds, selectTrash and purge", "Images gained hide, show and hidden"]) expect(findings[0]?.message).toContain(part);
  });

  it("types/breaking-signatures names what focus and crop changed", async () => {
    const findings = await typeSignaturesRule.check(contextFor(await project({})));
    for (const part of ["Images gained setFraming and framingsOf", "Variant gained crop, renderedCrop, originalWidth and originalHeight"]) expect(findings[0]?.message).toContain(part);
  });

  it("responses/breaking-step-shapes names the not-ready 404 and the sync job's eligible total", async () => {
    const p = await project({ pipelines: [{ name: "images", steps: ["images.generate", "images.retryFailed", "images.sync", "images.readStatus", "media.reconcile"] }] });
    const byStep = new Map((await breakingStepShapesRule.check(contextFor(p))).map((f) => [f.where.step, f.message]));
    expect(byStep.get("images.generate")).toContain("404 for an item that is not ready");
    expect(byStep.get("images.retryFailed")).toContain("404 for an item that is not ready");
    expect(byStep.get("images.sync")).toContain("job.total counts the ready items that get variants");
    expect(byStep.get("images.readStatus")).toContain("job.total counts the ready items that get variants");
    expect(byStep.get("media.reconcile")).toContain("<prefix><id>/<name>");
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

  it("steps/ctx-done-terminal-output stays quiet for an installed package's own file, reached through a pnpm-style node_modules layout", async () => {
    const pkgDir = join(dir, "node_modules", ".pnpm", "@michaelthielemann+kestrel-events-direct@6.0.0", "node_modules", "@michaelthielemann", "kestrel-events-direct");
    await mkdir(join(pkgDir, "dist"), { recursive: true });
    const file = join(pkgDir, "dist", "index.js");
    await writeFile(file, 'exports.steps = () => ({ create: async (ctx) => ctx.done({ id: "x" }) });\n');
    const p = await project({ moduleFiles: { "events/direct": file } });
    expect(await ctxDoneTerminalOutputRule.check(contextFor(p))).toEqual([]);
  });
});

describe("pipelines/require-role", () => {
  const AUTHZ = { use: "@michaelthielemann/kestrel-authz-roles", config: { roles: { admin: ["*"] } } };

  it("inserts authz.requireRole right after authn.requireUser, and leaves me and logout alone", async () => {
    const file = join(dir, "pipelines.ts");
    const source = [
      'definePipeline({ name: "listUsers", steps: ["authn.requireUser", "authz.require:users.manage", "authn.listUsers"] });',
      'definePipeline({ name: "me", steps: ["authn.requireUser", "authn.loadIdentity"] });',
      'definePipeline({ name: "readPage", steps: ["authn.identifyUser", "authz.require:pages.read", "content.get:pages"] });',
      "",
    ].join("\n");
    await writeFile(file, source);
    const p = await project({
      configModules: [AUTHZ],
      pipelines: [
        { name: "listUsers", steps: ["authn.requireUser", "authz.require:users.manage", "authn.listUsers"] },
        { name: "me", steps: ["authn.requireUser", "authn.loadIdentity"] },
        { name: "readPage", steps: ["authn.identifyUser", "authz.require:pages.read", "content.get:pages"] },
      ],
      pipelineFiles: { listUsers: file, me: file, readPage: file },
    });
    const findings = await requireRoleRule.check(contextFor(p));
    expect(findings.map((f) => f.where.pipeline)).toEqual(["listUsers"]);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain('"authn.requireUser", "authz.requireRole", "authz.require:users.manage"');
    expect(text).toContain('name: "me", steps: ["authn.requireUser", "authn.loadIdentity"]');
    expect(findings[0]?.docs).toBe(upgradingDocs("pipelines-require-role"));
  });

  it("finds nothing once the step is there, without authz-roles, or for a pipeline the config names in rolelessPipelines", async () => {
    const done = await project({ configModules: [AUTHZ], pipelines: [{ name: "listUsers", steps: ["authn.requireUser", "authz.requireRole", "authn.listUsers"] }] });
    expect(await requireRoleRule.check(contextFor(done))).toEqual([]);
    const withoutAuthz = await project({ configModules: [], pipelines: [{ name: "listUsers", steps: ["authn.requireUser", "authn.listUsers"] }] });
    expect(await requireRoleRule.check(contextFor(withoutAuthz))).toEqual([]);
    const named = await project({ configModules: [{ ...AUTHZ, config: { ...AUTHZ.config, rolelessPipelines: ["profile"] } }], pipelines: [{ name: "profile", steps: ["authn.requireUser", "authn.loadIdentity"] }] });
    expect(await requireRoleRule.check(contextFor(named))).toEqual([]);
  });
});

describe("authz/media-list", () => {
  const MEDIA = { use: "@michaelthielemann/kestrel-media-default" };
  const roles = { admin: ["*"], editor: ["pages.*", "media.read"], author: ["media.*"], viewer: ["media.read", "media.list"], guest: ["pages.read"] };

  it("adds media.list to each written role that grants media.read without it", async () => {
    const p = await project({ configModules: [MEDIA, { use: "@michaelthielemann/kestrel-authz-roles", config: { roles } }] });
    const source = [
      "export default defineConfig({",
      "  modules: [",
      '    { use: "@michaelthielemann/kestrel-media-default" },',
      "    { use: \"@michaelthielemann/kestrel-authz-roles\", config: { roles: { admin: [\"*\"], editor: ['pages.*', 'media.read'], author: [\"media.*\"], viewer: [\"media.read\", \"media.list\"], guest: [\"pages.read\"] } } },",
      "  ],",
      "});",
      "",
    ].join("\n");
    await writeFile(p.configFile, source);
    const findings = await mediaListRule.check(contextFor(p));
    expect(findings.map((f) => f.id)).toEqual(["authz/media-list:editor"]);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    expect(applyEdits(source, edits).text).toContain("editor: ['pages.*', 'media.read', 'media.list']");
    expect(findings[0]?.docs).toBe(upgradingDocs("authz-media-list"));
  });

  it("follows media-default's listPermission, and finds nothing without media-default or with roles only from defaults", async () => {
    const custom = await project({ configModules: [{ ...MEDIA, config: { listPermission: "library.browse" } }, { use: "@michaelthielemann/kestrel-authz-roles", config: { roles: { viewer: ["media.read", "media.list"] } } }] });
    expect((await mediaListRule.check(contextFor(custom))).map((f) => f.id)).toEqual(["authz/media-list:viewer"]);
    const withoutMedia = await project({ configModules: [{ use: "@michaelthielemann/kestrel-authz-roles", config: { roles } }] });
    expect(await mediaListRule.check(contextFor(withoutMedia))).toEqual([]);
    const fromDefaults = await project({ configModules: [MEDIA, { use: "@michaelthielemann/kestrel-authz-roles", defaults: { from: "preset", values: { roles: { editor: ["media.read"] } } } }] });
    expect(await mediaListRule.check(contextFor(fromDefaults))).toEqual([]);
  });
});
