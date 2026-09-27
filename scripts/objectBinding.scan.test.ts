import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanObjectBindingCandidates, type ObjectBindingCandidate } from "./objectBinding.candidates.ts";
import { scanExamplePipelines, type ExamplePipeline } from "./objectBinding.examplePipelines.ts";
import { OBJECT_BINDING_REGISTRY, type ObjectBindingDisposition } from "./objectBinding.waivers.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = join(ROOT, "packages");
const EXAMPLES = join(ROOT, "examples");

const scan = scanObjectBindingCandidates(PACKAGES);

function stepPrefix(moduleName: string): string {
  return moduleName.split("/")[0] ?? moduleName;
}

function fullStepName(candidate: ObjectBindingCandidate): string {
  return `${stepPrefix(candidate.module)}.${candidate.step}`;
}

function upstreamIndexOf(steps: readonly string[], upstream: string): number {
  return steps.findIndex((step) => step === upstream || step.startsWith(`${upstream}:`));
}

export function upstreamViolations(candidates: readonly ObjectBindingCandidate[], registry: Record<string, ObjectBindingDisposition>, pipelines: readonly ExamplePipeline[]): string[] {
  const violations: string[] = [];
  for (const candidate of candidates) {
    const entry = registry[`${candidate.module}#${candidate.step}`];
    if (!entry || entry.kind !== "waiver" || entry.upstream === undefined) continue;
    const name = fullStepName(candidate);
    for (const pipeline of pipelines) {
      const at = pipeline.steps.indexOf(name);
      if (at === -1) continue;
      const upstreamAt = upstreamIndexOf(pipeline.steps, entry.upstream);
      if (upstreamAt === -1 || upstreamAt >= at) violations.push(`${pipeline.file}: "${pipeline.name}" runs ${name} without ${entry.upstream} before it`);
    }
  }
  return violations;
}

describe("object binding candidate scan", () => {
  it("scans the expected number of module files and steps", () => {
    expect(scan.moduleFileCount).toBe(28);
    expect(scan.stepCount).toBe(171);
  });

  it("finds the expected number of candidates", () => {
    expect(scan.candidates).toHaveLength(22);
  });

  for (const candidate of scan.candidates) {
    const key = `${candidate.module}#${candidate.step}`;
    it(key, () => {
      const entry = OBJECT_BINDING_REGISTRY[key];
      if (!entry) expect.fail(`${key} reads params.* plus another request-controlled value or an input schema (reads=${JSON.stringify(candidate.reads)}); it needs a foreign-id test or a waiver in objectBinding.waivers.ts`);
      if (entry.kind === "waiver") {
        expect(entry.reason.trim().length, `${key}: waiver reason must not be empty`).toBeGreaterThan(0);
        return;
      }
      const file = join(PACKAGES, entry.file);
      expect(existsSync(file), `${key}: waivers.ts names "${entry.file}" which does not exist`).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text.includes(`it("${entry.title}"`), `${key}: no test titled "${entry.title}" in ${entry.file}`).toBe(true);
    });
  }

  it("names no waiver or test for a step the scan no longer finds a candidate", () => {
    const known = new Set(scan.candidates.map((c) => `${c.module}#${c.step}`));
    const stale = Object.keys(OBJECT_BINDING_REGISTRY).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  it("every waiver naming an upstream step is honoured by the example pipelines that use the candidate", () => {
    const pipelines = scanExamplePipelines(EXAMPLES);
    expect(upstreamViolations(scan.candidates, OBJECT_BINDING_REGISTRY, pipelines)).toEqual([]);
  });
});

describe("upstreamViolations", () => {
  const candidate: ObjectBindingCandidate = { module: "widget/default", step: "reassign", reads: ["params.id"], hasInput: false, hasQuery: false };
  const registry: Record<string, ObjectBindingDisposition> = { "widget/default#reassign": { kind: "waiver", reason: "x", upstream: "authz.require" } };

  it("passes when the upstream step runs before the candidate", () => {
    const pipelines: ExamplePipeline[] = [{ file: "p.ts", name: "p", steps: ["authz.require", "widget.reassign"] }];
    expect(upstreamViolations([candidate], registry, pipelines)).toEqual([]);
  });

  it("fails when the upstream step is missing or runs after the candidate", () => {
    const missing: ExamplePipeline[] = [{ file: "p.ts", name: "p", steps: ["widget.reassign"] }];
    expect(upstreamViolations([candidate], registry, missing)).toHaveLength(1);
    const after: ExamplePipeline[] = [{ file: "q.ts", name: "q", steps: ["widget.reassign", "authz.require"] }];
    expect(upstreamViolations([candidate], registry, after)).toHaveLength(1);
  });

  it("ignores a pipeline that does not use the candidate at all", () => {
    const other: ExamplePipeline[] = [{ file: "r.ts", name: "r", steps: ["authz.require"] }];
    expect(upstreamViolations([candidate], registry, other)).toEqual([]);
  });

  it("matches a bare upstream name against a factory step spec carrying an arg", () => {
    const factoryRegistry: Record<string, ObjectBindingDisposition> = { "widget/default#reassign": { kind: "waiver", reason: "x", upstream: "authn.verifyUser" } };
    const withArg: ExamplePipeline[] = [{ file: "p.ts", name: "p", steps: ["authn.verifyUser:reassignTo", "widget.reassign"] }];
    expect(upstreamViolations([candidate], factoryRegistry, withArg)).toEqual([]);
    const withDifferentArg: ExamplePipeline[] = [{ file: "q.ts", name: "q", steps: ["authn.verifyUser:result.reassignTo", "widget.reassign"] }];
    expect(upstreamViolations([candidate], factoryRegistry, withDifferentArg)).toEqual([]);
  });
});

describe("scanObjectBindingCandidates: shapes it must reject", () => {
  function moduleSource(defineModuleBody: string): string {
    return `import { defineModule } from "@michaelthielemann/kestrel/defineModule";\nexport default defineModule(${defineModuleBody});\n`;
  }

  function writeAndScan(dir: string, source: string) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "module.ts"), source);
    try {
      return scanObjectBindingCandidates(resolve(dir, ".."));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const scratchRoot = join(ROOT, "node_modules", ".cache", "kestrel-object-binding-scan-fixtures");

  it("throws naming the file and step for a spread in a describe() entry", () => {
    const source = moduleSource(`{
      name: "widget/spread",
      provides: [],
      requires: [],
      configSchema: {},
      async setup() { return {}; },
      steps: () => ({ act: async (ctx) => ctx }),
      describe: () => ({ act: { summary: "s", reads: ["params.id", "payload.x"], writes: [], ...({}) } }),
    }`);
    expect(() => writeAndScan(join(scratchRoot, "spread-module"), source)).toThrow(/step "act".*spread/s);
  });

  it("throws naming the file and step for a non-literal reads value", () => {
    const source = moduleSource(`{
      name: "widget/nonliteral",
      provides: [],
      requires: [],
      configSchema: {},
      async setup() { return {}; },
      steps: () => ({ act: async (ctx) => ctx }),
      describe: () => ({ act: { summary: "s", reads: someExternalReads, writes: [] } }),
    }`);
    expect(() => writeAndScan(join(scratchRoot, "nonliteral-module"), source)).toThrow(/step "act".*reads.*not a literal array/s);
  });

  it("throws naming the file for a describe() defined elsewhere (an import the scan cannot follow)", () => {
    const source = `import { defineModule } from "@michaelthielemann/kestrel/defineModule";\nimport { describeWidget } from "./describe.ts";\nexport default defineModule({\n  name: "widget/elsewhere",\n  provides: [],\n  requires: [],\n  configSchema: {},\n  async setup() { return {}; },\n  steps: () => ({ act: async (ctx) => ctx }),\n  describe: describeWidget,\n});\n`;
    expect(() => writeAndScan(join(scratchRoot, "elsewhere-module"), source)).toThrow(/"describe".*could not be read/);
  });

  it("throws naming the file for steps built by a delegating factory the scan cannot inline", () => {
    const source = `import { defineModule } from "@michaelthielemann/kestrel/defineModule";\nimport { buildSteps } from "./steps.ts";\nexport default defineModule({\n  name: "widget/delegated",\n  provides: [],\n  requires: [],\n  configSchema: {},\n  async setup() { return {}; },\n  steps: (instance) => buildSteps(instance),\n  describe: () => ({ act: { summary: "s", reads: [], writes: [] } }),\n});\n`;
    expect(() => writeAndScan(join(scratchRoot, "delegated-module"), source)).toThrow(/"steps".*could not be read/);
  });

  it("unions a reads ternary and a full describe()-entry ternary instead of rejecting them", () => {
    const source = moduleSource(`{
      name: "widget/ternary",
      provides: [],
      requires: [],
      configSchema: {},
      async setup() { return {}; },
      steps: () => ({ act: (arg) => async (ctx) => ctx, other: (arg) => async (ctx) => ctx }),
      describe: () => ({
        act: (arg) => ({ summary: "s", reads: arg === "one" ? ["params.id"] : [], writes: [] }),
        other: (arg) => (arg === "one" ? { summary: "one", reads: ["params.id"], writes: [] } : { summary: "all", reads: [], writes: [] }),
      }),
    }`);
    const result = writeAndScan(join(scratchRoot, "ternary-module"), source);
    expect(result.stepCount).toBe(2);
    expect(result.candidates).toEqual([]);
  });

  it("counts an optional params/payload read as request-controlled", () => {
    const source = moduleSource(`{
      name: "widget/optional",
      provides: [],
      requires: [],
      configSchema: {},
      async setup() { return {}; },
      steps: () => ({ act: async (ctx) => ctx }),
      describe: () => ({ act: { summary: "s", reads: ["params.id?", "payload?"], writes: [] } }),
    }`);
    const result = writeAndScan(join(scratchRoot, "optional-module"), source);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ module: "widget/optional", step: "act", reads: ["params.id?", "payload?"] });
  });
});
