import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isString } from "./guards.ts";
import { runCli } from "./cli-run.ts";
import type { LoadResult, Rule, UpgradePlugin } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
      pipelineFiles: [],
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
  const code = await runCli(["check", "--root", root, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined, plugins });
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

describe("a backend package stays checked with a plugin active", () => {
  it("still flags an out-of-range backend package regardless of the active plugin", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-persistence-sqlite": "^5.8.0" } }));
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve(customProject()),
    };
    const { report } = await runJson([plugin]);
    expect(report.findings.some((f) => f.rule === "deps/kestrel-range")).toBe(true);
  });
});

describe("a plugin rule id colliding with a built-in", () => {
  it("is a load error, and the plugin's colliding rule never runs alongside the built-in", async () => {
    const collidingRule: Rule = {
      id: "deps/kestrel-range",
      check: () => [{ id: "deps/kestrel-range:custom", rule: "deps/kestrel-range", severity: "info", tier: "source", where: {}, message: "custom range check", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), rules: [collidingRule] };
    const { report } = await runJson([plugin]);
    const issue = report.findings.find((f) => f.rule === "load/failed");
    expect(issue?.message).toContain("deps/kestrel-range");
    expect(issue?.message).toContain("custom-host");
    expect(report.findings.some((f) => f.message === "custom range check")).toBe(false);
  });

  it("does not fire, and the plugin's own rule runs normally, when its ids do not collide", async () => {
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), rules: [customRule] };
    const { report } = await runJson([plugin]);
    expect(report.findings.some((f) => f.rule === "load/failed")).toBe(false);
    expect(report.findings.some((f) => f.rule === "plugin/custom")).toBe(true);
  });
});

describe("a plugin's sandbox entries", () => {
  it("are a load error naming the plugin and the entry when one collides with a built-in rewrite", async () => {
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), sandbox: { "@michaelthielemann/kestrel-persistence-sqlite": (config) => config } };
    const { report } = await runJson([plugin]);
    const issue = report.findings.find((f) => f.rule === "load/failed");
    expect(issue?.message).toContain("custom-host");
    expect(issue?.message).toContain("@michaelthielemann/kestrel-persistence-sqlite");
  });

  it("reports a key that matches no configured module as a warning naming the key and the plugin", async () => {
    const withArchive = (): LoadResult => {
      const loaded = customProject();
      return loaded.project === undefined ? loaded : { ...loaded, project: { ...loaded.project, input: { ...loaded.project.input, config: { modules: [{ use: "@acme/kestrel-archive", config: {} }], triggers: [] } } } };
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(withArchive()), sandbox: { "@acme/kestrel-archive": (config) => config, "@acme/kestrel-archive?copy": (config) => config, archive: (config) => config } };
    const lines: string[] = [];
    await runCli(["check", "--root", dir, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    const unmatched = report.findings.filter((f) => f.rule === "sandbox/unmatched-entry");
    expect(unmatched.map((f) => f.severity)).toEqual(["warning", "warning"]);
    expect(unmatched.map((f) => f.message).join("\n")).toContain('"@acme/kestrel-archive?copy"');
    expect(unmatched.map((f) => f.message).join("\n")).toContain('"archive"');
    expect(unmatched.every((f) => f.message.includes("custom-host"))).toBe(true);
  });

  it("does not fire for an entry keyed by another package's full use string", async () => {
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), sandbox: { "@acme/kestrel-archive": (config) => config } };
    const { report } = await runJson([plugin]);
    expect(report.findings.some((f) => f.rule === "load/failed")).toBe(false);
  });
});

describe("a plugin hook that throws is reported, not silently swallowed", () => {
  it("dataModel() throwing surfaces a plugin/hook-failed error finding naming the plugin and the hook", async () => {
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve(customProject()),
      dataModel: () => {
        throw new Error("boom");
      },
    };
    const { report } = await runJson([plugin]);
    const finding = report.findings.find((f) => f.rule === "plugin/hook-failed");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("custom-host");
    expect(finding?.message).toContain("dataModel");
    expect(finding?.message).toContain("boom");
  });

  it("does not fire when dataModel() resolves normally", async () => {
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), dataModel: () => Promise.resolve(undefined) };
    const { report } = await runJson([plugin]);
    expect(report.findings.some((f) => f.rule === "plugin/hook-failed")).toBe(false);
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
            project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: `project-at-${root}`, configFile: join(scratch, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] },
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
    const code = await runCli(["fix", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
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
    await runCli(["fix", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    await runCli(["fix", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(prepareCount).toBe(2);
  });

  it("documents the failure mode of caching a scratch-dependent value under a fixed key: a later call gets a directory the engine already removed", async () => {
    const seenScratchDirs: string[] = [];
    let cachedConfigFile: string | undefined;
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: (_root, scratch, cache) => {
        seenScratchDirs.push(scratch);
        if (!cache.has("configFile")) cache.set("configFile", join(scratch, "host.config.ts"));
        const cached = cache.get("configFile");
        const configFile = isString(cached) ? cached : join(scratch, "host.config.ts");
        cachedConfigFile = configFile;
        return Promise.resolve({
          project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "custom-host", configFile, moduleFiles: new Map(), pipelineFiles: [] },
          issues: [],
        });
      },
    };
    await runCli(["fix", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(seenScratchDirs.length).toBeGreaterThan(1);
    expect(new Set(seenScratchDirs).size).toBeGreaterThan(1);
    expect(cachedConfigFile).toBe(join(seenScratchDirs[0]!, "host.config.ts"));
    expect(cachedConfigFile).not.toBe(join(seenScratchDirs.at(-1)!, "host.config.ts"));
    expect(existsSync(seenScratchDirs[0]!)).toBe(false);
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
    await runCli(["check", "--root", dir, "--json", "--data-report", reportFile], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });

    expect(seenData).toEqual({ pluginOwnKey: "plugin value" });
    expect(seenDataReport).toEqual({ underscoreFields: { "page._hint": { unlocalized: 0 } } });
  });
});

describe("cli-run's remap: a path outside the scratch copy", () => {
  it("leaves a finding's node_modules path unchanged, instead of corrupting it, for a root that is not a sibling of the scratch dir at the same depth", async () => {
    const zodMain = createRequire(import.meta.url).resolve("zod");
    const nestedBase = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-remap-nested-"));
    try {
      const deepRoot = join(nestedBase, "a", "b", "c", "project");
      await mkdir(deepRoot, { recursive: true });
      await writeFile(join(deepRoot, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
      const probeRule: Rule = {
        id: "plugin/node-modules-probe",
        check: () => [{ id: "plugin/node-modules-probe", rule: "plugin/node-modules-probe", severity: "info", tier: "source", where: { file: zodMain }, message: "probe", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }],
      };
      const plugin: UpgradePlugin = {
        kind: "custom-host",
        detect: (root) => root === deepRoot,
        load: () =>
          Promise.resolve({
            project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "custom-host", configFile: join(deepRoot, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] },
            issues: [],
          }),
        rules: [probeRule],
      };
      const { report } = await runJsonAt(deepRoot, [plugin]);
      const finding = report.findings.find((f) => f.rule === "plugin/node-modules-probe");
      expect(finding?.where.file).toBe(zodMain);
    } finally {
      await rm(nestedBase, { recursive: true, force: true });
    }
  });

  it("keeps a plugin's DataContentModel.file rename auto and applies it, for a project root that is not a sibling of the scratch dir at the same depth", async () => {
    const nestedBase = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-remap-nested-"));
    try {
      const deepRoot = join(nestedBase, "a", "b", "c", "project");
      await mkdir(deepRoot, { recursive: true });
      await writeFile(join(deepRoot, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
      const modelFile = join(deepRoot, "content-model.ts");
      const modelSource = 'export default { modules: [{ use: "custom-content", config: { types: { page: { fields: { _hint: { type: "string" } } } } } }] };\n';
      await writeFile(modelFile, modelSource);
      const reportFile = join(deepRoot, "data-report.json");
      await writeFile(reportFile, JSON.stringify({ underscoreFields: { "page._hint": { unlocalized: 0 } } }));

      const plugin: UpgradePlugin = {
        kind: "custom-host",
        detect: (root) => root === deepRoot,
        load: () =>
          Promise.resolve({
            project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "custom-host", configFile: join(deepRoot, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] },
            issues: [],
          }),
        dataModel: () => Promise.resolve({ use: "custom-content", file: modelFile, types: { page: { fields: { _hint: {} } } } }),
      };

      const lines: string[] = [];
      const code = await runCli(["fix", "--root", deepRoot, "--write", "--yes", "--allow-dirty", "--json", "--data-report", reportFile], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
      expect(code === 0 || code === 1).toBe(true);
      const text = await readFile(modelFile, "utf8");
      expect(text).toContain("fields: { hint:");
    } finally {
      await rm(nestedBase, { recursive: true, force: true });
    }
  });
});

describe("a read-only check never writes into the real project through previewBoot", () => {
  it("refuses (returns undefined) a preview edit targeting a real-root path, and never touches the file", async () => {
    const realConfigFile = join(dir, "host.config.ts");
    const originalSource = "export default { modules: [], triggers: [] };\n";
    await writeFile(realConfigFile, originalSource);
    let previewResult: unknown = "not-called";
    const probeRule: Rule = {
      id: "probe/real-root",
      async check(ctx) {
        if (!ctx.previewBoot) return [];
        const edit = { file: ctx.project.configFile, start: 0, end: 0, text: "// injected by the probe\n" };
        previewResult = await ctx.previewBoot([edit]);
        return [];
      },
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), rules: [probeRule] };

    await runCli(["check", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(previewResult).toBeUndefined();
    expect(await readFile(realConfigFile, "utf8")).toBe(originalSource);
  });

  it("still runs a normal preview when the edit targets a path inside scratch", async () => {
    let previewResult: unknown = "not-called";
    const probeRule: Rule = {
      id: "probe/in-scratch",
      async check(ctx) {
        if (!ctx.previewBoot) return [];
        const edit = { file: ctx.project.configFile, start: 0, end: 0, text: "" };
        previewResult = await ctx.previewBoot([edit]);
        return [];
      },
    };
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: (_root, scratch) => {
        const configFile = join(scratch, "host.config.ts");
        return Promise.resolve({ project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "custom-host", configFile, moduleFiles: new Map(), pipelineFiles: [] }, issues: [] });
      },
      rules: [probeRule],
    };
    await runCli(["check", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(previewResult).not.toBe("not-called");
    expect(previewResult).toBeDefined();
  });

  it("refuses a create edit that would land inside the scratch copy's own symlinked node_modules, so writeFileSync cannot follow it into the real package", async () => {
    await writeFile(join(dir, "host.config.ts"), "export default { modules: [], triggers: [] };\n");
    const realPkgDir = join(dir, "node_modules", "widget");
    await mkdir(realPkgDir, { recursive: true });
    await writeFile(join(realPkgDir, "package.json"), JSON.stringify({ name: "widget", version: "1.0.0" }));
    let previewResult: unknown = "not-called";
    let scratchPkgFile = "";
    const probeRule: Rule = {
      id: "probe/node-modules-symlink",
      async check(ctx) {
        if (!ctx.previewBoot) return [];
        scratchPkgFile = join(ctx.scratch, "node_modules", "widget", "injected.js");
        const edit = { file: scratchPkgFile, start: 0, end: 0, text: "// injected by the probe\n", create: true as const };
        previewResult = await ctx.previewBoot([edit]);
        return [];
      },
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), rules: [probeRule] };
    const lines: string[] = [];
    await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(previewResult).toBeUndefined();
    expect(existsSync(join(realPkgDir, "injected.js"))).toBe(false);
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    const refused = report.findings.find((f) => f.rule === "preview/edit-refused");
    expect(refused?.message).toContain("through a symlink");
    expect(refused?.where.file).toBe(join(dir, "node_modules", "widget", "injected.js"));
    expect(refused?.where.file).not.toBe(scratchPkgFile);
  });

  it("still runs a normal create-edit preview when the whole scratch copy sits behind a symlinked TMPDIR", async () => {
    await writeFile(join(dir, "host.config.ts"), "export default { modules: [], triggers: [] };\n");
    const realTmp = join(dir, "real-tmp");
    const linkedTmp = join(dir, "tmp-link");
    await mkdir(realTmp, { recursive: true });
    await symlink(realTmp, linkedTmp, "dir");
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = linkedTmp;
    try {
      let previewResult: unknown = "not-called";
      const probeRule: Rule = {
        id: "probe/symlinked-tmpdir",
        async check(ctx) {
          if (!ctx.previewBoot) return [];
          const newFile = join(ctx.scratch, "new-pipeline.ts");
          const edit = { file: newFile, start: 0, end: 0, text: "export default {};\n", create: true as const };
          previewResult = await ctx.previewBoot([edit]);
          return [];
        },
      };
      const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), rules: [probeRule] };
      await runCli(["check", "--root", dir, "--json"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
      expect(previewResult).not.toBe("not-called");
      expect(previewResult).toBeDefined();
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }
  });

  it("adds a preview/edit-refused finding naming the path and the reason, instead of leaving the cause invisible", async () => {
    const realConfigFile = join(dir, "host.config.ts");
    await writeFile(realConfigFile, "export default { modules: [], triggers: [] };\n");
    const probeRule: Rule = {
      id: "probe/real-root-finding",
      async check(ctx) {
        if (!ctx.previewBoot) return [];
        const edit = { file: ctx.project.configFile, start: 0, end: 0, text: "// injected\n" };
        await ctx.previewBoot([edit]);
        return [];
      },
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject()), rules: [probeRule] };
    const lines: string[] = [];
    await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    const refused = report.findings.find((f) => f.rule === "preview/edit-refused");
    expect(refused).toBeDefined();
    expect(refused?.message).toContain("outside its own scratch copy");
    expect(refused?.where.file).toBe(realConfigFile);
  });
});

function scratchProject(scratch: string): LoadResult {
  return { project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "custom-host", configFile: join(scratch, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] }, issues: [] };
}

describe("fix's own final preview, before any write", () => {
  it("reports could not verify the boot result instead of a clean 0-errors summary, when an auto edit's own create target has no directory", async () => {
    await writeFile(join(dir, "host.config.ts"), "export default { modules: [], triggers: [] };\n");
    const badCreateRule: Rule = {
      id: "probe/create-missing-dir",
      check: (ctx) => [
        {
          id: "probe/create-missing-dir",
          rule: "probe/create-missing-dir",
          severity: "warning",
          tier: "source",
          where: {},
          message: "probe: creates a file in a directory that does not exist",
          suggestion: "n/a",
          fix: { kind: "auto", edits: [{ file: join(dirname(ctx.project.configFile), "does-not-exist", "new-file.ts"), start: 0, end: 0, text: "export {};\n", create: true as const }] },
          docs: "n/a",
        },
      ],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: (_root, scratch) => Promise.resolve(scratchProject(scratch)), rules: [badCreateRule] };
    const lines: string[] = [];
    await runCli(["fix", "--root", dir], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(lines.some((l) => l.startsWith("after these edits:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("could not verify the boot result:") && l.includes("ENOENT"))).toBe(true);
  });
});

describe("fix never writes through a scratch path that maps into the real project's node_modules", () => {
  it("refuses the finding instead of writing, and the dry-run shows the refusal instead of a diff", async () => {
    await writeFile(join(dir, "host.config.ts"), "export default { modules: [], triggers: [] };\n");
    const realPkgDir = join(dir, "node_modules", "widget");
    await mkdir(realPkgDir, { recursive: true });
    const pkgFile = join(realPkgDir, "package.json");
    const originalPkgSource = JSON.stringify({ name: "widget", version: "1.0.0" });
    await writeFile(pkgFile, originalPkgSource);
    const badRule: Rule = {
      id: "probe/node-modules-write",
      check: (ctx) => {
        const target = join(ctx.scratch, "node_modules", "widget", "package.json");
        const source = ctx.readFile(target) ?? "{}";
        return [
          {
            id: "probe/node-modules-write",
            rule: "probe/node-modules-write",
            severity: "warning",
            tier: "source",
            where: {},
            message: "probe: edits a file under node_modules",
            suggestion: "n/a",
            fix: { kind: "auto", edits: [{ file: target, start: 0, end: source.length, text: JSON.stringify({ name: "widget", version: "2.0.0" }) }] },
            docs: "n/a",
          },
        ];
      },
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: (_root, scratch) => Promise.resolve(scratchProject(scratch)), rules: [badRule] };

    const dryLines: string[] = [];
    await runCli(["check", "--root", dir, "--json"], { stdout: (l) => dryLines.push(l), stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    const checkReport = boundaryCast<UpgradeReport>(JSON.parse(dryLines.join("\n")), "json");
    const checkFinding = checkReport.findings.find((f) => f.rule === "probe/node-modules-write");
    expect(checkFinding?.fix.kind).toBe("manual");
    expect(checkFinding?.suggestion).toContain("node_modules");

    const fixLines: string[] = [];
    await runCli(["fix", "--root", dir], { stdout: (l) => fixLines.push(l), stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(fixLines.some((l) => l.includes("package.json") && l.startsWith("---"))).toBe(false);

    await runCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin], forceInstalledMajor: 6 });
    expect(await readFile(pkgFile, "utf8")).toBe(originalPkgSource);
  });
});
