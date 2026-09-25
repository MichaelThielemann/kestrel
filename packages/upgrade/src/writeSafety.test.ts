import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";
import type { LoadedProject, Rule, UpgradePlugin } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";

const run = promisify(execFile);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-write-safety-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function customProject(configFile: string): LoadedProject {
  return {
    input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] },
    kind: "custom-host",
    configFile,
    moduleFiles: new Map(),
    pipelineFiles: [],
  };
}

describe("fix never writes an edit that fails to re-parse", () => {
  it("drops the corrupting finding's edit, leaves the file untouched, and reports it manual", async () => {
    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default { a: 1, b: 2 };\n");
    const goodRule: Rule = {
      id: "plugin/good",
      check: () => [
        { id: "plugin/good", rule: "plugin/good", severity: "error", tier: "source", where: {}, message: "good", suggestion: "n/a", fix: { kind: "auto", edits: [{ file: configFile, start: 20, end: 21, text: "3" }] }, docs: "n/a" },
      ],
    };
    const badRule: Rule = {
      id: "plugin/bad",
      check: () => [
        { id: "plugin/bad", rule: "plugin/bad", severity: "error", tier: "source", where: {}, message: "bad", suggestion: "replace b", fix: { kind: "auto", edits: [{ file: configFile, start: 0, end: 0, text: "}}}not valid ts{{{" }] }, docs: "n/a" },
      ],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [goodRule, badRule] };

    const lines: string[] = [];
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    const text = readFileSync(configFile, "utf8");
    expect(text).toBe("export default { a: 3, b: 2 };\n");
    expect(text).not.toContain("not valid ts");

    const lines2: string[] = [];
    await runUpgradeCli(["fix", "--root", dir, "--json"], { stdout: (l) => lines2.push(l), stderr: () => undefined, plugins: [plugin] });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines2[0]!), "json");
    const bad = report.findings.find((f) => f.rule === "plugin/bad");
    expect(bad?.fix.kind).toBe("manual");
  });

  it("rejects the whole finding, in every file it touches, when any one of its edits fails to re-parse", async () => {
    const configFile = join(dir, "host.config.ts");
    const otherFile = join(dir, "other.ts");
    await writeFile(configFile, "export default { a: 1 };\n");
    await writeFile(otherFile, "export const x = 1;\n");
    const multiFileBadRule: Rule = {
      id: "plugin/multi",
      check: () => [
        {
          id: "plugin/multi",
          rule: "plugin/multi",
          severity: "error",
          tier: "source",
          where: {},
          message: "spans two files, one breaks",
          suggestion: "n/a",
          fix: {
            kind: "auto",
            edits: [
              { file: otherFile, start: 12, end: 13, text: "2" },
              { file: configFile, start: 0, end: 0, text: "}}}broken{{{" },
            ],
          },
          docs: "n/a",
        },
      ],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [multiFileBadRule] };
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    expect(readFileSync(otherFile, "utf8")).toBe("export const x = 1;\n");
    expect(readFileSync(configFile, "utf8")).toBe("export default { a: 1 };\n");
  });
});

describe("fix never silently drops a conflicting edit from a different rule", () => {
  it("downgrades the later-processed rule to manual, naming the conflicting rule, instead of silently applying only one of the two edits", async () => {
    const configFile = join(dir, "host.config.ts");
    const source = "export default { a: 1, b: 2 };\n";
    await writeFile(configFile, source);
    const aValueStart = source.indexOf("a: 1");
    const oneEnd = aValueStart + "a: 1".length;
    const twoEnd = source.indexOf("b: 2") + "b: 2".length;
    const ruleFirst: Rule = {
      id: "plugin/rule-first",
      check: () => [{ id: "plugin/rule-first", rule: "plugin/rule-first", severity: "error", tier: "source", where: {}, message: "first", suggestion: "n/a", fix: { kind: "auto", edits: [{ file: configFile, start: aValueStart, end: oneEnd, text: "a: 100" }] }, docs: "n/a" }],
    };
    const ruleSecond: Rule = {
      id: "plugin/rule-second",
      check: () => [{ id: "plugin/rule-second", rule: "plugin/rule-second", severity: "error", tier: "source", where: {}, message: "second", suggestion: "n/a", fix: { kind: "auto", edits: [{ file: configFile, start: oneEnd - 1, end: twoEnd, text: "1, b: 999" }] }, docs: "n/a" }],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [ruleFirst, ruleSecond] };

    const lines: string[] = [];
    await runUpgradeCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines[0]!), "json");
    const findingFirst = report.findings.find((f) => f.rule === "plugin/rule-first");
    const findingSecond = report.findings.find((f) => f.rule === "plugin/rule-second");
    expect(findingFirst?.fix.kind).toBe("auto");
    expect(findingSecond?.fix.kind).toBe("manual");
    expect(findingSecond?.suggestion).toContain("plugin/rule-first");

    const writeCode = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
    expect(writeCode).toBe(1);
    const text = readFileSync(configFile, "utf8");
    expect(text).toBe("export default { a: 100, b: 2 };\n");
  });
});

describe("fix can create a new file, all-or-nothing with the rest of the finding", () => {
  it("writes a brand-new file whose edit is marked create", async () => {
    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default {};\n");
    const newFile = join(dir, "created.ts");
    const rule: Rule = {
      id: "plugin/create",
      check: () => [{ id: "plugin/create", rule: "plugin/create", severity: "error", tier: "source", where: {}, message: "create", suggestion: "n/a", fix: { kind: "auto", edits: [{ file: newFile, start: 0, end: 0, text: "export const created = true;\n", create: true }] }, docs: "n/a" }],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [rule] };
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    expect(readFileSync(newFile, "utf8")).toBe("export const created = true;\n");
  });

  it("refuses (downgrades to manual) when the file a create edit targets already exists, and never overwrites it", async () => {
    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default {};\n");
    const existingFile = join(dir, "existing.ts");
    await writeFile(existingFile, "export const original = true;\n");
    const rule: Rule = {
      id: "plugin/create-exists",
      check: () => [{ id: "plugin/create-exists", rule: "plugin/create-exists", severity: "error", tier: "source", where: {}, message: "create", suggestion: "n/a", fix: { kind: "auto", edits: [{ file: existingFile, start: 0, end: 0, text: "export const overwritten = true;\n", create: true }] }, docs: "n/a" }],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [rule] };

    const lines: string[] = [];
    await runUpgradeCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines[0]!), "json");
    const f = report.findings.find((x) => x.rule === "plugin/create-exists");
    expect(f?.fix.kind).toBe("manual");
    expect(f?.suggestion).toContain("already exists");

    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    expect(readFileSync(existingFile, "utf8")).toBe("export const original = true;\n");
  });

  it("downgrades the later rule to manual, naming the conflicting rule, when two rules try to create the same new file", async () => {
    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default {};\n");
    const newFile = join(dir, "created.ts");
    const ruleFirst: Rule = {
      id: "plugin/create-first",
      check: () => [{ id: "plugin/create-first", rule: "plugin/create-first", severity: "error", tier: "source", where: {}, message: "first", suggestion: "n/a", fix: { kind: "auto", edits: [{ file: newFile, start: 0, end: 0, text: "export const first = true;\n", create: true }] }, docs: "n/a" }],
    };
    const ruleSecond: Rule = {
      id: "plugin/create-second",
      check: () => [{ id: "plugin/create-second", rule: "plugin/create-second", severity: "error", tier: "source", where: {}, message: "second", suggestion: "n/a", fix: { kind: "auto", edits: [{ file: newFile, start: 0, end: 0, text: "export const second = true;\n", create: true }] }, docs: "n/a" }],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [ruleFirst, ruleSecond] };

    const lines: string[] = [];
    await runUpgradeCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines[0]!), "json");
    const findingFirst = report.findings.find((f) => f.rule === "plugin/create-first");
    const findingSecond = report.findings.find((f) => f.rule === "plugin/create-second");
    expect(findingFirst?.fix.kind).toBe("auto");
    expect(findingSecond?.fix.kind).toBe("manual");
    expect(findingSecond?.suggestion).toContain("plugin/create-first");

    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    expect(readFileSync(newFile, "utf8")).toBe("export const first = true;\n");
  });

  it("never creates the file when another part of the same all-or-nothing finding fails to verify", async () => {
    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default {};\n");
    const otherFile = join(dir, "other.ts");
    await writeFile(otherFile, "export const x = 1;\n");
    const newFile = join(dir, "created.ts");
    const rule: Rule = {
      id: "plugin/create-and-break",
      check: () => [
        {
          id: "plugin/create-and-break",
          rule: "plugin/create-and-break",
          severity: "error",
          tier: "source",
          where: {},
          message: "create and break",
          suggestion: "n/a",
          fix: {
            kind: "auto",
            edits: [
              { file: newFile, start: 0, end: 0, text: "export const created = true;\n", create: true },
              { file: otherFile, start: 0, end: 0, text: "}}}broken{{{" },
            ],
          },
          docs: "n/a",
        },
      ],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [rule] };
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    expect(existsSync(newFile)).toBe(false);
    expect(readFileSync(otherFile, "utf8")).toBe("export const x = 1;\n");
  });
});

describe("fix --write runs the dirty guard for every touched file before writing any of them", () => {
  it("writes nothing at all when one of several touched files is dirty", async () => {
    await run("git", ["init"], { cwd: dir });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await run("git", ["config", "user.name", "t"], { cwd: dir });
    const cleanFile = join(dir, "clean.ts");
    const dirtyFile = join(dir, "dirty.ts");
    await writeFile(cleanFile, "export const clean = 1;\n");
    await writeFile(dirtyFile, "export const dirty = 1;\n");
    await run("git", ["add", "-A"], { cwd: dir });
    await run("git", ["commit", "-m", "initial"], { cwd: dir });
    await writeFile(dirtyFile, "export const dirty = 1; // uncommitted\n");

    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default {};\n");
    const rule: Rule = {
      id: "plugin/two-files",
      check: () => [
        {
          id: "plugin/two-files",
          rule: "plugin/two-files",
          severity: "error",
          tier: "source",
          where: {},
          message: "touches both",
          suggestion: "n/a",
          fix: {
            kind: "auto",
            edits: [
              { file: cleanFile, start: 13, end: 18, text: "wrote" },
              { file: dirtyFile, start: 13, end: 18, text: "wrote" },
            ],
          },
          docs: "n/a",
        },
      ],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [rule] };
    let errored = "";
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: (l) => { errored = l; }, plugins: [plugin] });
    expect(code).toBe(2);
    expect(errored).toContain("dirty.ts");
    expect(readFileSync(cleanFile, "utf8")).toBe("export const clean = 1;\n");
  });

  it("refuses (exit 2), never overwrites, when git itself cannot run inside a real repository", async () => {
    await run("git", ["init"], { cwd: dir });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await run("git", ["config", "user.name", "t"], { cwd: dir });
    const touchedFile = join(dir, "touched.ts");
    await writeFile(touchedFile, "export const touched = 1;\n");
    await run("git", ["add", "-A"], { cwd: dir });
    await run("git", ["commit", "-m", "initial"], { cwd: dir });

    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default {};\n");
    const rule: Rule = {
      id: "plugin/one-file",
      check: () => [
        {
          id: "plugin/one-file",
          rule: "plugin/one-file",
          severity: "error",
          tier: "source",
          where: {},
          message: "touches the file",
          suggestion: "n/a",
          fix: { kind: "auto", edits: [{ file: touchedFile, start: 13, end: 20, text: "changed" }] },
          docs: "n/a",
        },
      ],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [rule] };

    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    let errored = "";
    let code: number;
    try {
      code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: (l) => { errored = l; }, plugins: [plugin] });
    } finally {
      process.env.PATH = originalPath;
    }
    expect(code).toBe(2);
    expect(errored).toContain("touched.ts");
    expect(readFileSync(touchedFile, "utf8")).toBe("export const touched = 1;\n");
  });

  it("still writes when git cannot run at all outside any git tree", async () => {
    const touchedFile = join(dir, "touched.ts");
    await writeFile(touchedFile, "export const touched = 1;\n");
    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default {};\n");
    const rule: Rule = {
      id: "plugin/one-file",
      check: () => [
        {
          id: "plugin/one-file",
          rule: "plugin/one-file",
          severity: "error",
          tier: "source",
          where: {},
          message: "touches the file",
          suggestion: "n/a",
          fix: { kind: "auto", edits: [{ file: touchedFile, start: 13, end: 20, text: "changed" }] },
          docs: "n/a",
        },
      ],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [rule] };

    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    let code: number;
    try {
      code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
    } finally {
      process.env.PATH = originalPath;
    }
    expect(code).toBe(1);
    expect(readFileSync(touchedFile, "utf8")).toBe("export const changed = 1;\n");
  });
});

describe("fix never writes through a project-level file symlink to outside the project", () => {
  it("downgrades the finding to manual on check, and leaves the outside file untouched on fix --write", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-outside-"));
    try {
      const outsideFile = join(outsideDir, "shared.ts");
      const originalOutsideSource = "export const shared = 1;\n";
      await writeFile(outsideFile, originalOutsideSource);

      await run("git", ["init"], { cwd: dir });
      await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
      await run("git", ["config", "user.name", "t"], { cwd: dir });
      const linkedFile = join(dir, "shared.ts");
      await symlink(outsideFile, linkedFile);
      await run("git", ["add", "-A"], { cwd: dir });
      await run("git", ["commit", "-m", "initial"], { cwd: dir });

      const configFile = join(dir, "host.config.ts");
      await writeFile(configFile, "export default {};\n");
      const rule: Rule = {
        id: "plugin/through-symlink",
        check: () => [
          {
            id: "plugin/through-symlink",
            rule: "plugin/through-symlink",
            severity: "error",
            tier: "source",
            where: {},
            message: "edits a file that is a symlink out of the project",
            suggestion: "n/a",
            fix: { kind: "auto", edits: [{ file: linkedFile, start: originalOutsideSource.indexOf("1"), end: originalOutsideSource.indexOf("1") + 1, text: "2" }] },
            docs: "n/a",
          },
        ],
      };
      const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [rule] };

      const lines: string[] = [];
      await runUpgradeCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
      const report = boundaryCast<UpgradeReport>(JSON.parse(lines[0]!), "json");
      const finding = report.findings.find((f) => f.rule === "plugin/through-symlink");
      expect(finding?.fix.kind).toBe("manual");
      expect(finding?.suggestion).toContain("outside the project");

      await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
      expect(readFileSync(outsideFile, "utf8")).toBe(originalOutsideSource);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("fix --write always says what happened, even when it wrote nothing", () => {
  it("names the finding and the reason, instead of printing nothing, when its only edit fails to verify", async () => {
    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default { a: 1 };\n");
    const badRule: Rule = {
      id: "plugin/bad",
      check: () => [
        { id: "plugin/bad", rule: "plugin/bad", severity: "error", tier: "source", where: {}, message: "bad", suggestion: "replace a", fix: { kind: "auto", edits: [{ file: configFile, start: 0, end: 0, text: "}}}not valid ts{{{" }] }, docs: "n/a" },
      ],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [badRule] };
    const lines: string[] = [];
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    expect(readFileSync(configFile, "utf8")).toBe("export default { a: 1 };\n");
    expect(lines.some((l) => l.startsWith("wrote ") && !l.startsWith("wrote nothing:"))).toBe(false);
    expect(lines).toContain("wrote nothing: every proposed edit failed to verify");
    expect(lines.some((l) => l.includes("plugin/bad") && l.includes("replace a"))).toBe(true);
  });

  it("says so, instead of printing nothing, when no open finding has an edit to apply at all", async () => {
    const configFile = join(dir, "host.config.ts");
    await writeFile(configFile, "export default { a: 1 };\n");
    const manualRule: Rule = {
      id: "plugin/manual-only",
      check: () => [{ id: "plugin/manual-only", rule: "plugin/manual-only", severity: "error", tier: "source", where: {}, message: "needs a human", suggestion: "fix it by hand", fix: { kind: "manual" }, docs: "n/a" }],
    };
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve({ project: customProject(configFile), issues: [] }), rules: [manualRule] };
    const lines: string[] = [];
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("wrote ") && !l.startsWith("wrote nothing:"))).toBe(false);
    expect(lines).toContain("wrote nothing: no finding had an edit to apply");
  });
});
