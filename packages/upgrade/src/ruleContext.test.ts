import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuleContext, PLUGIN_API_VERSION, type LoadedProject, type ProjectRule, type StepListLocator } from "./plugin.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-rule-context-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function project(): LoadedProject {
  return {
    input: { config: { modules: [{ use: "@acme/kestrel-archive", config: {} }], triggers: [] }, modules: [], pipelines: [] },
    kind: "custom-host",
    configFile: join(dir, "host.config.ts"),
    moduleFiles: new Map(),
    pipelineFiles: [],
  };
}

describe("PLUGIN_API_VERSION", () => {
  it("is a positive integer a plugin can compare against", () => {
    expect(Number.isInteger(PLUGIN_API_VERSION)).toBe(true);
    expect(PLUGIN_API_VERSION).toBeGreaterThan(0);
  });
});

describe("createRuleContext", () => {
  it("fills every member but the project with an empty default rooted at the config file's directory", () => {
    const ctx = createRuleContext(project());
    expect(ctx.root).toBe(dir);
    expect(ctx.scratch).toBe(dir);
    expect(ctx.project.kind).toBe("custom-host");
    expect(ctx.bootCheck).toEqual({ errors: [], warnings: [], notChecked: [] });
    expect([...ctx.answers]).toEqual([]);
    expect(ctx.previewBoot).toBeUndefined();
  });

  it("reads files from disk, answering undefined for a missing one", async () => {
    await writeFile(join(dir, "host.config.ts"), "export default {};\n");
    const ctx = createRuleContext(project());
    expect(ctx.readFile(join(dir, "host.config.ts"))).toBe("export default {};\n");
    expect(ctx.readFile(join(dir, "missing.ts"))).toBeUndefined();
  });

  it("takes an override for any other member", () => {
    const locateSteps: StepListLocator = () => [];
    const ctx = createRuleContext(project(), { root: "/elsewhere", answers: new Map([["plugin/custom", "yes"]]), locateSteps });
    expect(ctx.root).toBe("/elsewhere");
    expect(ctx.answers.get("plugin/custom")).toBe("yes");
    expect(ctx.locateSteps).toBe(locateSteps);
  });

  it("is what a plugin's rule check() runs against in a test", async () => {
    const rule: ProjectRule = {
      id: "plugin/archive-module",
      check: (ctx) => ctx.project.input.config.modules.map((m) => ({ id: `plugin/archive-module:${m.use}`, rule: "plugin/archive-module", severity: "info", tier: "source", where: {}, message: m.use, suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" })),
    };
    const findings = await rule.check(createRuleContext(project()));
    expect(findings.map((f) => f.message)).toEqual(["@acme/kestrel-archive"]);
  });
});
