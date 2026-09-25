import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";
import type { Rule, UpgradePlugin } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-source-tier-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a needs: source rule runs even when the project itself never loaded", () => {
  it("bumps the dependency range with fix --write, for a backend project whose kestrel.config.ts throws on load", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel": "^5.8.0" } }, null, 2));
    await writeFile(join(dir, "kestrel.config.ts"), 'throw new Error("this project\'s own config throws on load");\n');

    const checkLines: string[] = [];
    await runCli(["check", "--root", dir, "--json"], { stdout: (l) => checkLines.push(l), stderr: () => undefined });
    const report = boundaryCast<UpgradeReport>(JSON.parse(checkLines.join("\n")), "json");
    expect(report.tiers.source).toBe("failed");
    expect(report.findings.some((f) => f.rule === "load/failed")).toBe(true);
    const rangeFinding = report.findings.find((f) => f.rule === "deps/kestrel-range");
    expect(rangeFinding?.fix.kind).toBe("auto");

    const dryLines: string[] = [];
    await runCli(["fix", "--root", dir], { stdout: (l) => dryLines.push(l), stderr: () => undefined });
    expect(dryLines.some((l) => l.includes("the project itself did not load"))).toBe(true);

    const code = await runCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined });
    expect(code).toBe(1);
    const pkg = boundaryCast<{ dependencies: Record<string, string> }>(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), "json");
    expect(pkg.dependencies["@michaelthielemann/kestrel"]).toBe("^6.0.0");
  });

  it("still runs a plugin's own needs: source rule when the plugin's load() fails", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }, null, 2));
    const probeRule: Rule = {
      id: "plugin/probe-source",
      needs: "source",
      check: (ctx) => (ctx.readFile(join(ctx.root, "package.json")) === undefined ? [] : [{ id: "plugin/probe-source", rule: "plugin/probe-source", severity: "info", tier: "source", where: {}, message: "the plugin's own source rule ran", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }]),
    };
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.reject(new Error("this plugin's own load() always fails")),
      rules: [probeRule],
    };

    const lines: string[] = [];
    await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    expect(report.tiers.source).toBe("failed");
    expect(report.findings.some((f) => f.rule === "load/failed")).toBe(true);
    expect(report.findings.some((f) => f.rule === "plugin/probe-source")).toBe(true);
  });
});

describe("a rule's own check() failing never aborts the whole run", () => {
  it("reports plugin/hook-failed and keeps the report, when a needs: source rule mislabels itself and reaches into ctx.project", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }, null, 2));
    const mislabeledRule: Rule = {
      id: "plugin/mislabeled-source",
      needs: "source",
      check: (ctx) => {
        const project = boundaryCast<{ project: { input: unknown } }>(ctx, "host").project;
        return [{ id: "plugin/mislabeled-source", rule: "plugin/mislabeled-source", severity: "info", tier: "source", where: {}, message: JSON.stringify(project.input), suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }];
      },
    };
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: (_root, scratch) => Promise.resolve({ project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "custom-host", configFile: join(scratch, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] }, issues: [] }),
      rules: [mislabeledRule],
    };

    const lines: string[] = [];
    const code = await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    expect(code).not.toBe(2);
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    const failed = report.findings.find((f) => f.rule === "plugin/hook-failed" && f.id.includes("plugin/mislabeled-source"));
    expect(failed).toBeDefined();
    expect(failed?.message).toContain("plugin/mislabeled-source");
  });

  it("reports plugin/hook-failed and still runs every other rule, when an ordinary project rule's check() throws", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }, null, 2));
    const throwingRule: Rule = {
      id: "plugin/throws",
      check: () => {
        throw new Error("boom");
      },
    };
    const okRule: Rule = {
      id: "plugin/ok",
      check: () => [{ id: "plugin/ok", rule: "plugin/ok", severity: "info", tier: "source", where: {}, message: "still ran", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }],
    };
    const plugin: UpgradePlugin = {
      kind: "custom-host",
      detect: () => true,
      load: () => Promise.resolve({ project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "custom-host", configFile: join(dir, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] }, issues: [] }),
      rules: [throwingRule, okRule],
    };

    const lines: string[] = [];
    const code = await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    expect(code).not.toBe(2);
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    const failed = report.findings.find((f) => f.rule === "plugin/hook-failed" && f.id.includes("plugin/throws"));
    expect(failed).toBeDefined();
    expect(failed?.message).toContain("boom");
    expect(report.findings.some((f) => f.rule === "plugin/ok")).toBe(true);
  });
});
