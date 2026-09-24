import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";
import type { LoadResult, Rule, UpgradePlugin } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-plugin-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function customProject(): LoadResult {
  return {
    project: {
      input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] },
      kind: "custom-host",
      configFile: join(dir, "host.config.ts"),
      moduleFiles: new Map(),
      pipelineFiles: new Map(),
    },
    issues: [],
  };
}

const customRule: Rule = {
  id: "plugin/custom",
  check: () => [{ id: "plugin/custom", rule: "plugin/custom", severity: "info", tier: "source", where: {}, message: "from the plugin", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }],
};

async function runJsonAt(root: string, plugins: readonly UpgradePlugin[]): Promise<{ code: number; report: UpgradeReport }> {
  const lines: string[] = [];
  const code = await runUpgradeCli(["check", "--root", root, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined, plugins });
  return { code, report: boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json") };
}

async function runJson(plugins: readonly UpgradePlugin[]): Promise<{ code: number; report: UpgradeReport }> {
  return runJsonAt(dir, plugins);
}

describe("a plugin registered through RunUpgradeCliOptions.plugins", () => {
  it("is never consulted when it does not detect the project", async () => {
    let detected = false;
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => {
        detected = true;
        return false;
      },
      load: () => Promise.resolve(customProject()),
      rules: [customRule],
    };
    const { report } = await runJson([plugin]);
    expect(detected).toBe(true);
    expect(report.project.kind).not.toBe("custom-host");
    expect(report.findings.some((f) => f.rule === "plugin/custom")).toBe(false);
  });

  it("its load() replaces the built-in backend loader once detect() matches", async () => {
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve(customProject()),
    };
    const { report } = await runJson([plugin]);
    expect(report.project.kind).toBe("custom-host");
  });

  it("its rules run alongside DEFAULT_RULES and their findings appear in the report", async () => {
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve(customProject()),
      rules: [customRule],
    };
    const { report } = await runJson([plugin]);
    const finding = report.findings.find((f) => f.rule === "plugin/custom");
    expect(finding?.message).toBe("from the plugin");
  });

  it("falls back to the built-in loader when no plugin detects the project", async () => {
    const { report } = await runJson([]);
    expect(report.project.kind).toBe("unknown");
  });

  it("reports a plugin whose detect() throws as a load/failed finding, instead of silently dropping its rules", async () => {
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => {
        throw new Error("boom");
      },
      load: () => Promise.resolve(customProject()),
      rules: [customRule],
    };
    const { report } = await runJson([plugin]);
    expect(report.project.kind).toBe("unknown");
    const issue = report.findings.find((f) => f.rule === "load/failed");
    expect(issue?.message).toContain("custom-host");
    expect(issue?.message).toContain("boom");
  });
});

describe("UpgradePlugin.load()'s LoadResult", () => {
  it("surfaces a partial issue as load/failed even while the project itself loads", async () => {
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve({ ...customProject(), issues: [{ message: "one file of the custom project did not load" }] }),
    };
    const { report } = await runJson([plugin]);
    expect(report.project.kind).toBe("custom-host");
    const issue = report.findings.find((f) => f.rule === "load/failed");
    expect(issue?.message).toBe("one file of the custom project did not load");
  });
});

describe("UpgradePlugin.ownsPackages", () => {
  it("keeps deps/kestrel-range from touching a package the plugin owns", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-example-plugin": "^1.0.0" } }));
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve(customProject()),
      ownsPackages: ["@michaelthielemann/kestrel-example-plugin"],
    };
    const { report } = await runJson([plugin]);
    expect(report.findings.some((f) => f.rule === "deps/kestrel-range")).toBe(false);
  });

  it("still flags an out-of-range backend package the plugin does not own", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-persistence-sqlite": "^5.8.0" } }));
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve(customProject()),
      ownsPackages: ["@michaelthielemann/kestrel-example-plugin"],
    };
    const { report } = await runJson([plugin]);
    expect(report.findings.some((f) => f.rule === "deps/kestrel-range")).toBe(true);
  });
});

describe("UpgradePlugin.overrides", () => {
  it("replaces a built-in rule's finding with the plugin's own, and reports the replacement", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-persistence-sqlite": "^5.8.0" } }));
    const replacement: Rule = {
      id: "deps/kestrel-range",
      check: () => [{ id: "deps/kestrel-range:custom", rule: "deps/kestrel-range", severity: "info", tier: "source", where: {}, message: "custom range check", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }],
    };
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve(customProject()),
      overrides: { "deps/kestrel-range": replacement },
    };
    const { report } = await runJson([plugin]);
    expect(report.findings.find((f) => f.rule === "deps/kestrel-range")?.message).toBe("custom range check");
    expect(report.findings.some((f) => f.rule === "plugin/rule-replaced")).toBe(true);
  });

  it("disables a built-in rule entirely when overridden with null", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-persistence-sqlite": "^5.8.0" } }));
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve(customProject()),
      overrides: { "deps/kestrel-range": null },
    };
    const { report } = await runJson([plugin]);
    expect(report.findings.some((f) => f.rule === "deps/kestrel-range")).toBe(false);
    expect(report.findings.some((f) => f.rule === "plugin/rule-disabled")).toBe(true);
  });

  it("is a load error when two registered plugins override the same rule id", async () => {
    const ruleA: Rule = { id: "deps/kestrel-range", check: () => [] };
    const ruleB: Rule = { id: "deps/kestrel-range", check: () => [] };
    const pluginA: UpgradePlugin = { kind: "plugin-a", detect: () => true, load: () => Promise.resolve(customProject()), overrides: { "deps/kestrel-range": ruleA } };
    const pluginB: UpgradePlugin = { kind: "plugin-b", detect: () => false, load: () => Promise.resolve(customProject()), overrides: { "deps/kestrel-range": ruleB } };
    const { report } = await runJson([pluginA, pluginB]);
    const issue = report.findings.find((f) => f.rule === "load/failed");
    expect(issue?.message).toContain("deps/kestrel-range");
    expect(issue?.message).toContain("more than one");
  });
});

describe("loader isolation across two projects in one process", () => {
  it("gives load() a fresh, unique scratch directory for every call, never reusing one across projects or rounds", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "kestrel-upgrade-plugin-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "kestrel-upgrade-plugin-b-"));
    try {
      await writeFile(join(dirA, "package.json"), JSON.stringify({ name: "app-a", dependencies: {} }));
      await writeFile(join(dirB, "package.json"), JSON.stringify({ name: "app-b", dependencies: {} }));
      const seenScratchDirs = new Set<string>();
      const plugin: UpgradePlugin = {
        kind: "custom-host",
        detect: () => true,
        load: (root, scratch) => {
          seenScratchDirs.add(scratch);
          return Promise.resolve({
            project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: `project-at-${root}`, configFile: join(scratch, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: new Map() },
            issues: [],
          });
        },
      };
      const { report: reportA } = await runJsonAt(dirA, [plugin]);
      const { report: reportB } = await runJsonAt(dirB, [plugin]);
      const { report: reportAAgain } = await runJsonAt(dirA, [plugin]);
      expect(reportA.project.kind).toBe(`project-at-${dirA}`);
      expect(reportB.project.kind).toBe(`project-at-${dirB}`);
      expect(reportAAgain.project.kind).toBe(`project-at-${dirA}`);
      expect(seenScratchDirs.size).toBe(3);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });
});

describe("UpgradePlugin.load()'s cache parameter", () => {
  it("is the same Map across every load() call within one fix invocation, so an expensive prepare step runs once", async () => {
    let prepareCount = 0;
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: (_root, _scratch, cache) => {
        if (!cache.has("prepared")) {
          prepareCount++;
          cache.set("prepared", true);
        }
        return Promise.resolve(customProject());
      },
    };
    const code = await runUpgradeCli(["fix", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(code === 0 || code === 1).toBe(true);
    expect(prepareCount).toBe(1);
  });

  it("is a fresh Map for a separate fix invocation, even for the same project", async () => {
    let prepareCount = 0;
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: (_root, _scratch, cache) => {
        if (!cache.has("prepared")) {
          prepareCount++;
          cache.set("prepared", true);
        }
        return Promise.resolve(customProject());
      },
    };
    await runUpgradeCli(["fix", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    await runUpgradeCli(["fix", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(prepareCount).toBe(2);
  });
});

describe("--data-report alongside a plugin that stores its own project.data", () => {
  it("keeps the plugin's own data and carries --data-report separately, in project.dataReport", async () => {
    const reportFile = join(dir, "data-report.json");
    await writeFile(reportFile, JSON.stringify({ underscoreFields: { "page._hint": { unlocalized: 0 } } }));

    let seenData: unknown;
    let seenDataReport: unknown;
    const probeRule: Rule = {
      id: "plugin/data-probe",
      check(ctx) {
        seenData = ctx.project.data;
        seenDataReport = ctx.project.dataReport;
        return [];
      },
    };
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () =>
        Promise.resolve({
          project: { ...customProject().project!, data: { pluginOwnKey: "plugin value" } },
          issues: [],
        }),
      rules: [probeRule],
    };
    const lines: string[] = [];
    await runUpgradeCli(["check", "--root", dir, "--json", "--data-report", reportFile], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });

    expect(seenData).toEqual({ pluginOwnKey: "plugin value" });
    expect(seenDataReport).toEqual({ underscoreFields: { "page._hint": { unlocalized: 0 } } });
  });
});
