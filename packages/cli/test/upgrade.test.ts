import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "@michaelthielemann/kestrel-upgrade/plugin";
import type { UpgradeReport } from "@michaelthielemann/kestrel-upgrade";
import type { CheckReport } from "../src/commands/check.ts";
import { CLI_DIR, REPO, removeDir, runCli, tempDir } from "./harness.ts";

const UPGRADE_FIXTURES = join(REPO, "packages", "upgrade", "__fixtures__");
const VERSION = boundaryCast<{ version: string }>(JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")), "json").version;
const MATCHING = `^${VERSION.split(".")[0] ?? "0"}.0.0`;
const SIDE_EFFECT = "entry-ran";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function pluginSource(options: { detect?: string; factoryThrows?: boolean } = {}): string {
  return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(import.meta.dirname, "${SIDE_EFFECT}"), "yes");
const rule = { id: "example/source", needs: "source", check: () => [{ id: "example/source", rule: "example/source", severity: "warning", tier: "source", where: {}, message: "from the host plugin", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }] };
export default (host) => {
  ${options.factoryThrows === true ? 'throw new Error("factory broke");' : ""}
  return {
    kind: "example-host",
    detect: () => ${options.detect ?? "true"},
    load: async (_root, scratch) => ({ project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "example-host", configFile: join(scratch, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] }, issues: [] }),
    rules: [rule],
    hostChecks: () => [{ code: "example-host-check", severity: "warning", owner: "example-host", reason: "checked by the host, api " + host.pluginApiVersion }],
  };
};
`;
}

function hostProject(label: string): string {
  const dir = tempDir(label);
  dirs.push(dir);
  mkdirSync(join(dir, "node_modules", "@michaelthielemann"), { recursive: true });
  symlinkSync(join(REPO, "packages", "core"), join(dir, "node_modules", "@michaelthielemann", "kestrel"), "dir");
  writeFileSync(join(dir, "host.config.ts"), "export default {};\n");
  return dir;
}

function installHost(root: string, name: string, kestrel: Record<string, unknown> | undefined, plugin = pluginSource()): string {
  const pkgDir = join(root, "node_modules", name);
  mkdirSync(join(pkgDir, "cli"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version: "3.0.0", type: "module", ...(kestrel === undefined ? {} : { kestrel }) }));
  writeFileSync(join(pkgDir, "cli", "plugin.mjs"), plugin);
  return pkgDir;
}

function writeProject(root: string, dependencies: Record<string, string>): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true, type: "module", dependencies: { "@michaelthielemann/kestrel": MATCHING, ...dependencies } }));
}

const FIELD = { plugin: "./cli/plugin.mjs", pluginApi: 4, engine: MATCHING };

describe("kestrel upgrade passes argv through to the upgrade engine", { timeout: 60_000 }, () => {
  it("prints the same report as runUpgradeCli for the same arguments", async () => {
    const fixture = join(UPGRADE_FIXTURES, "minimal-5.8");
    const lines: string[] = [];
    const expectedCode = await runUpgradeCli(["check", "--json", "--root", fixture], { stdout: (l) => lines.push(l), stderr: () => undefined });
    const result = await runCli(["upgrade", "check", "--json", "--root", fixture]);
    expect(result.code).toBe(expectedCode);
    const scratchFree = (text: string): string => text.replace(/kestrel-upgrade-[A-Za-z0-9]+/g, "kestrel-upgrade-scratch");
    expect(scratchFree(result.stdout.trimEnd())).toBe(scratchFree(lines.join("\n")));
  });

  it("keeps the exit codes: 0 for a clean project, 2 for fix --write without a terminal, 2 for an unknown subcommand", async () => {
    expect((await runCli(["upgrade", "check", "--root", join(UPGRADE_FIXTURES, "routed-6.0")], { env: { KESTREL_UPGRADE_FORCE_MAJOR: "6" } })).code).toBe(0);
    expect((await runCli(["upgrade", "fix", "--write", "--root", join(UPGRADE_FIXTURES, "minimal-5.8")])).code).toBe(2);
    expect((await runCli(["upgrade", "nope"])).code).toBe(2);
  });
});

describe("host plugin discovery", { timeout: 60_000 }, () => {
  it("loads a direct dependency's plugin: its rule reaches upgrade, its kind and host checks reach check, found through --root after the subcommand", async () => {
    const dir = hostProject("discovery");
    installHost(dir, "example-host", FIELD);
    writeProject(dir, { "example-host": "3.0.0" });
    const upgrade = await runCli(["upgrade", "check", "--json", "--root", dir], { cwd: REPO });
    const report = boundaryCast<UpgradeReport>(JSON.parse(upgrade.stdout), "json");
    expect(report.project.kind).toBe("example-host");
    expect(report.findings.some((f) => f.rule === "example/source")).toBe(true);

    const check = await runCli(["check", "--json", "--root", dir]);
    expect(check.code).toBe(0);
    const checked = boundaryCast<CheckReport>(JSON.parse(check.stdout), "json");
    expect(checked.plugins).toEqual([{ package: "example-host", version: "3.0.0", kind: "example-host" }]);
    expect(checked.host).toEqual([{ code: "example-host-check", severity: "warning", owner: "example-host", reason: "checked by the host, api 4" }]);
    const human = await runCli(["check", "--root", dir]);
    expect(human.stdout).toContain("plugins: example-host 3.0.0");
  });

  it("never loads a declaring package that is only a transitive dependency", async () => {
    const dir = hostProject("discovery-transitive");
    const host = installHost(dir, "example-host", FIELD);
    const direct = join(dir, "node_modules", "direct-dep");
    mkdirSync(direct);
    writeFileSync(join(direct, "package.json"), JSON.stringify({ name: "direct-dep", version: "1.0.0", dependencies: { "example-host": "3.0.0" } }));
    writeProject(dir, { "direct-dep": "1.0.0" });
    const result = await runCli(["upgrade", "check", "--json", "--root", dir]);
    expect(boundaryCast<UpgradeReport>(JSON.parse(result.stdout), "json").findings.some((f) => f.rule === "example/source")).toBe(false);
    expect(existsSync(join(host, "cli", SIDE_EFFECT))).toBe(false);
  });

  for (const [label, field, setup] of [
    ["an escaping path", { ...FIELD, plugin: "../../evil.mjs" }, undefined],
    ["a symlink out of the package", FIELD, "symlink"],
    ["a TypeScript entry", { ...FIELD, plugin: "./cli/plugin.ts" }, "ts"],
    ["a plugin API newer than the engine", { ...FIELD, pluginApi: 99 }, undefined],
    ["a malformed engine range", { ...FIELD, engine: "6" }, undefined],
  ] as const) {
    it(`refuses ${label} with exit 2, naming the package, without running its entry`, async () => {
      const dir = hostProject("discovery-refused");
      writeFileSync(join(dir, "evil.mjs"), pluginSource());
      const host = installHost(dir, "example-host", field);
      if (setup === "symlink") {
        removeDir(join(host, "cli", "plugin.mjs"));
        symlinkSync(join(dir, "evil.mjs"), join(host, "cli", "plugin.mjs"));
      }
      if (setup === "ts") writeFileSync(join(host, "cli", "plugin.ts"), pluginSource());
      writeProject(dir, { "example-host": "3.0.0" });
      for (const args of [["upgrade", "check", "--root", dir], ["check", "--root", dir], ["explain", "x", "--root", dir]]) {
        const result = await runCli(args);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('"example-host"');
      }
      expect(existsSync(join(dir, SIDE_EFFECT))).toBe(false);
      expect(existsSync(join(host, "cli", SIDE_EFFECT))).toBe(false);
    });
  }

  it("refuses two dependencies whose plugins both detect the project, naming both", async () => {
    const dir = hostProject("discovery-two");
    installHost(dir, "example-host", FIELD);
    installHost(dir, "other-host", FIELD);
    writeProject(dir, { "example-host": "3.0.0", "other-host": "3.0.0" });
    const result = await runCli(["upgrade", "check", "--root", dir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/"example-host".*"other-host"/);
  });

  it("refuses a throwing factory and a throwing detect by name", async () => {
    for (const plugin of [pluginSource({ factoryThrows: true }), pluginSource({ detect: '(() => { throw new Error("detect broke"); })()' })]) {
      const dir = hostProject("discovery-throws");
      installHost(dir, "example-host", FIELD, plugin);
      writeProject(dir, { "example-host": "3.0.0" });
      const result = await runCli(["check", "--root", dir]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('"example-host"');
      expect(result.stderr).toMatch(/factory broke|detect broke/);
    }
  });

  it("uses the built-in loader with --no-plugins", async () => {
    const dir = hostProject("discovery-off");
    const host = installHost(dir, "example-host", FIELD);
    writeProject(dir, { "example-host": "3.0.0" });
    const result = await runCli(["upgrade", "check", "--json", "--no-plugins", "--root", dir]);
    expect(boundaryCast<UpgradeReport>(JSON.parse(result.stdout), "json").project.kind).not.toBe("example-host");
    expect(existsSync(join(host, "cli", SIDE_EFFECT))).toBe(false);
    const check = await runCli(["check", "--no-plugins", "--root", dir]);
    expect(check.code).toBe(2);
    expect(check.stderr).toContain("no kestrel.config.ts");
  });

  it("reports an outdated host package from check with exit 1 and refuses fix --write", async () => {
    const dir = hostProject("discovery-outdated");
    installHost(dir, "example-host", { ...FIELD, engine: `^${Number(VERSION.split(".")[0]) - 1}.0.0` });
    writeProject(dir, { "example-host": "3.0.0" });
    const check = await runCli(["check", "--json", "--root", dir]);
    expect(check.code).toBe(1);
    expect(boundaryCast<CheckReport>(JSON.parse(check.stdout), "json").host.map((h) => h.code)).toEqual(["deps/host-outdated"]);
    const fix = await runCli(["upgrade", "fix", "--write", "--yes", "--root", dir]);
    expect(fix.code).toBe(2);
    expect(fix.stderr).toContain("is not built for this kestrel-cli");
  });
});
