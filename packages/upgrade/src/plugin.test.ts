import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";
import type { LoadedProject, Rule, UpgradePlugin } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-plugin-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function customProject(): LoadedProject {
  return {
    input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] },
    kind: "custom-host",
    configFile: join(dir, "host.config.ts"),
    moduleFiles: new Map(),
    pipelineFiles: new Map(),
  };
}

const customRule: Rule = {
  id: "plugin/custom",
  check: () => [{ id: "plugin/custom", rule: "plugin/custom", severity: "info", tier: "source", where: {}, message: "from the plugin", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }],
};

async function runJson(plugins: readonly UpgradePlugin[]): Promise<{ code: number; report: UpgradeReport }> {
  const lines: string[] = [];
  const code = await runUpgradeCli(["check", "--root", dir, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined, plugins });
  return { code, report: boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json") };
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
});
