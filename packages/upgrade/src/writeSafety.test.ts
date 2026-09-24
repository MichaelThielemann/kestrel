import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
    pipelineFiles: new Map(),
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
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject(configFile)), rules: [goodRule, badRule] };

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
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject(configFile)), rules: [multiFileBadRule] };
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(1);
    expect(readFileSync(otherFile, "utf8")).toBe("export const x = 1;\n");
    expect(readFileSync(configFile, "utf8")).toBe("export default { a: 1 };\n");
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
    const plugin: UpgradePlugin = { kind: "custom-host", detect: () => true, load: () => Promise.resolve(customProject(configFile)), rules: [rule] };
    let errored = "";
    const code = await runUpgradeCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: (l) => { errored = l; }, plugins: [plugin] });
    expect(code).toBe(2);
    expect(errored).toContain("dirty.ts");
    expect(readFileSync(cleanFile, "utf8")).toBe("export const clean = 1;\n");
  });
});
