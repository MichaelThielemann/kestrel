import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";
import { loadHostPlugins, satisfiesCaret, scanHosts, selectHostPlugin } from "./hosts.ts";
import { PLUGIN_API_MIN, PLUGIN_API_VERSION, type OpsFacts, type UpgradePlugin } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";
import { toolVersion } from "./versions.ts";

const VERSION = toolVersion();
const MAJOR = Number(VERSION.split(".")[0]);
const MATCHING = `^${MAJOR}.0.0`;
const OLDER = `^${MAJOR - 1}.0.0`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-hosts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SIDE_EFFECT = "entry-ran";

function pluginSource(options: { detect?: string; rule?: boolean } = {}): string {
  const rules = options.rule === true ? `rules: [{ id: "example/source", needs: "source", check: () => [{ id: "example/source", rule: "example/source", severity: "warning", tier: "source", where: {}, message: "from the host plugin", suggestion: "n/a", fix: { kind: "none" }, docs: "n/a" }] }],` : "";
  return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(import.meta.dirname, "..", "${SIDE_EFFECT}"), "yes");
export default (host) => ({ kind: "example-host", detect: () => ${options.detect ?? "true"}, load: async () => ({ issues: [] }), ${rules} host });
`;
}

async function installHost(root: string, name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<string> {
  const pkgDir = join(root, "node_modules", name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }, null, 2));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(pkgDir, file)), { recursive: true });
    await writeFile(join(pkgDir, file), text);
  }
  return pkgDir;
}

async function writeProject(root: string, dependencies: Record<string, string>): Promise<void> {
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", private: true, type: "module", dependencies }, null, 2));
}

describe("satisfiesCaret", () => {
  it("accepts the same major at or above the range's version and nothing else", () => {
    expect(satisfiesCaret("6.1.0", "^6.0.0")).toBe(true);
    expect(satisfiesCaret("6.0.0", "^6.0.1")).toBe(false);
    expect(satisfiesCaret("7.0.0", "^6.0.0")).toBe(false);
    expect(satisfiesCaret("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfiesCaret("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfiesCaret("6.0.0", ">=6.0.0")).toBe(false);
  });
});

describe("scanHosts classifies direct dependencies by their kestrel field, as data", () => {
  it("finds a declaring direct dependency loadable when its engine range matches the running version", async () => {
    await installHost(dir, "example-host", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }, { "cli/plugin.mjs": pluginSource() });
    await writeProject(dir, { "example-host": "1.0.0" });
    const scan = scanHosts(dir, { cliVersion: VERSION });
    expect(scan.loadable.map((h) => h.package)).toEqual(["example-host"]);
    expect(scan.outdated).toEqual([]);
    expect(scan.refused).toEqual([]);
    expect(existsSync(join(dir, "node_modules", "example-host", SIDE_EFFECT))).toBe(false);
  });

  it("flags as outdated a dependency on the upgrade engine without the field, an older engine range and a plugin API below the minimum", async () => {
    await installHost(dir, "host-without-field", { dependencies: { "@michaelthielemann/kestrel-upgrade": "^5.8.0" } });
    await installHost(dir, "host-older-engine", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN, engine: OLDER } }, { "cli/plugin.mjs": pluginSource() });
    await installHost(dir, "host-older-api", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN - 1, engine: MATCHING } }, { "cli/plugin.mjs": pluginSource() });
    await writeProject(dir, { "host-without-field": "1.0.0", "host-older-engine": "1.0.0", "host-older-api": "1.0.0" });
    const scan = scanHosts(dir, { cliVersion: VERSION });
    expect(scan.outdated.map((h) => h.package).sort()).toEqual(["host-older-api", "host-older-engine", "host-without-field"]);
    expect(scan.loadable).toEqual([]);
    for (const host of scan.outdated) expect(host.message).toContain(`"${host.package}" 1.0.0 is not built for this kestrel-cli`);
  });

  it("never classifies kestrel's own packages, even one that depends on the upgrade engine", async () => {
    await installHost(dir, "@michaelthielemann/kestrel-openapi", { dependencies: { "@michaelthielemann/kestrel-upgrade": "^6.0.0" } });
    await writeProject(dir, { "@michaelthielemann/kestrel-openapi": "^6.0.0" });
    expect(scanHosts(dir, { cliVersion: VERSION })).toEqual({ loadable: [], outdated: [], refused: [] });
  });

  it("ignores a declaring package that is only a transitive dependency", async () => {
    await installHost(dir, "example-host", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }, { "cli/plugin.mjs": pluginSource() });
    await installHost(dir, "direct-dep", { dependencies: { "example-host": "1.0.0" } });
    await writeProject(dir, { "direct-dep": "1.0.0" });
    expect(scanHosts(dir, { cliVersion: VERSION })).toEqual({ loadable: [], outdated: [], refused: [] });
  });

  it("refuses an escaping, symlinked, TypeScript, too new or malformed declaration without importing it", async () => {
    await writeFile(join(dir, "evil.mjs"), pluginSource());
    await installHost(dir, "host-dotdot", { kestrel: { plugin: "../../evil.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } });
    const linked = await installHost(dir, "host-symlink", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } });
    await mkdir(join(linked, "cli"), { recursive: true });
    await symlink(join(dir, "evil.mjs"), join(linked, "cli", "plugin.mjs"));
    await installHost(dir, "host-ts", { kestrel: { plugin: "./cli/plugin.ts", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }, { "cli/plugin.ts": pluginSource() });
    await installHost(dir, "host-api-99", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: 99, engine: MATCHING } }, { "cli/plugin.mjs": pluginSource() });
    await installHost(dir, "host-bare-engine", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN, engine: String(MAJOR) } }, { "cli/plugin.mjs": pluginSource() });
    await installHost(dir, "host-absolute", { kestrel: { plugin: join(dir, "evil.mjs"), pluginApi: PLUGIN_API_MIN, engine: MATCHING } });
    await writeProject(dir, { "host-dotdot": "1.0.0", "host-symlink": "1.0.0", "host-ts": "1.0.0", "host-api-99": "1.0.0", "host-bare-engine": "1.0.0", "host-absolute": "1.0.0" });
    const scan = scanHosts(dir, { cliVersion: VERSION });
    expect(scan.loadable).toEqual([]);
    const reasons = new Map(scan.refused.map((h) => [h.package, h.reason]));
    expect([...reasons.keys()].sort()).toEqual(["host-absolute", "host-api-99", "host-bare-engine", "host-dotdot", "host-symlink", "host-ts"]);
    expect(reasons.get("host-dotdot")).toContain("leaves the package directory");
    expect(reasons.get("host-symlink")).toContain("through a symlink");
    expect(reasons.get("host-ts")).toContain("not a .mjs or .js file");
    expect(reasons.get("host-api-99")).toBe(`needs plugin API 99, this kestrel-cli has ${PLUGIN_API_VERSION}; update kestrel-cli`);
    expect(reasons.get("host-bare-engine")).toContain("is not of the form");
    expect(reasons.get("host-absolute")).toContain("absolute path");
    expect(existsSync(join(dir, SIDE_EFFECT))).toBe(false);
  });
});

describe("loading and selecting host plugins", () => {
  it("passes the running engine's API version to the factory and refuses a throwing factory by name", async () => {
    await installHost(dir, "example-host", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }, { "cli/plugin.mjs": pluginSource() });
    await installHost(dir, "throwing-host", { kestrel: { plugin: "./plugin.js", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }, { "plugin.js": 'export default () => { throw new Error("factory broke"); };\n' });
    await writeProject(dir, { "example-host": "1.0.0", "throwing-host": "1.0.0" });
    await writeFile(join(dir, "node_modules", "throwing-host", "package.json"), JSON.stringify({ name: "throwing-host", version: "1.0.0", type: "module", kestrel: { plugin: "./plugin.js", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }));
    const scan = scanHosts(dir, { cliVersion: VERSION });
    const { loaded, refused } = await loadHostPlugins(scan.loadable, { pluginApiVersion: PLUGIN_API_VERSION, cliVersion: VERSION });
    expect(loaded.map((h) => [h.package, h.kind])).toEqual([["example-host", "example-host"]]);
    expect(boundaryCast<{ host: unknown }>(loaded[0]!.plugin, "host").host).toEqual({ pluginApiVersion: PLUGIN_API_VERSION, cliVersion: VERSION });
    expect(refused.map((r) => r.package)).toEqual(["throwing-host"]);
    expect(refused[0]?.reason).toContain("factory broke");
  });

  it("refuses more than one detecting plugin, naming both, and a throwing detect", async () => {
    await installHost(dir, "host-a", { kestrel: { plugin: "./p.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }, { "p.mjs": pluginSource() });
    await installHost(dir, "host-b", { kestrel: { plugin: "./p.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }, { "p.mjs": pluginSource() });
    await installHost(dir, "host-c", { kestrel: { plugin: "./p.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } }, { "p.mjs": pluginSource({ detect: '(() => { throw new Error("detect broke"); })()' }) });
    await writeProject(dir, { "host-a": "1.0.0", "host-b": "1.0.0" });
    const { loaded } = await loadHostPlugins(scanHosts(dir, { cliVersion: VERSION }).loadable, { pluginApiVersion: PLUGIN_API_VERSION, cliVersion: VERSION });
    const both = await selectHostPlugin(loaded, dir);
    expect(both.ok).toBe(false);
    expect(both.ok ? "" : both.message).toMatch(/"host-a".*"host-b"/);

    await writeProject(dir, { "host-c": "1.0.0" });
    const { loaded: throwing } = await loadHostPlugins(scanHosts(dir, { cliVersion: VERSION }).loadable, { pluginApiVersion: PLUGIN_API_VERSION, cliVersion: VERSION });
    const selection = await selectHostPlugin(throwing, dir);
    expect(selection.ok ? "" : selection.message).toContain('"host-c"');
  });
});

describe("plugin API 6", () => {
  it("is the engine's plugin API, and 4 stays the lowest a host may declare", () => {
    expect(PLUGIN_API_VERSION).toBe(6);
    expect(PLUGIN_API_MIN).toBe(4);
  });

  it("keeps loading a host that declares plugin API 5 and runs its rules", async () => {
    await installHost(dir, "api5-host", { type: "module", kestrel: { plugin: "./cli/plugin.mjs", pluginApi: 5, engine: MATCHING } }, { "cli/plugin.mjs": pluginSource({ rule: true }) });
    await writeProject(dir, { "api5-host": "1.0.0" });
    const scan = scanHosts(dir, { cliVersion: VERSION });
    expect(scan.loadable.map((h) => [h.package, h.pluginApi])).toEqual([["api5-host", 5]]);
    expect(scan.outdated).toEqual([]);
    expect(scan.refused).toEqual([]);
    const { loaded, refused } = await loadHostPlugins(scan.loadable, { pluginApiVersion: PLUGIN_API_VERSION, cliVersion: VERSION });
    expect(refused).toEqual([]);
    const lines: string[] = [];
    await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: loaded.map((h) => h.plugin), hosts: scan });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    expect(report.findings.map((f) => f.id)).toContain("example/source");
  });

  it("lets a plugin describe its operations facts without the upgrade commands calling the hook", async () => {
    let called = 0;
    const plugin: UpgradePlugin = {
      kind: "ops-host",
      detect: () => true,
      load: async () => ({ issues: [] }),
      ops: (): OpsFacts => {
        called += 1;
        return { readyPath: "/api/ready", secretEnvNames: ["EXAMPLE_SECRET"], migrationSwitches: { storage: "EXAMPLE_STORAGE_MIGRATIONS" }, databaseFile: (env) => env.EXAMPLE_DB, blobstoreFromEnv: () => ({ use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./blobs" } }) };
      },
    };
    await writeProject(dir, {});
    const lines: string[] = [];
    await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    expect(report.project.kind).toBe("ops-host");
    expect(report.findings.filter((f) => f.rule === "plugin/hook-failed")).toEqual([]);
    expect(called).toBe(0);
  });

  it("accepts a host that declares plugin API 6 and refuses one that needs 7", async () => {
    await installHost(dir, "api6-host", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: 6, engine: MATCHING } }, { "cli/plugin.mjs": pluginSource() });
    await installHost(dir, "api7-host", { kestrel: { plugin: "./cli/plugin.mjs", pluginApi: 7, engine: MATCHING } }, { "cli/plugin.mjs": pluginSource() });
    await writeProject(dir, { "api6-host": "1.0.0", "api7-host": "1.0.0" });
    const scan = scanHosts(dir, { cliVersion: VERSION });
    expect(scan.loadable.map((h) => h.package)).toEqual(["api6-host"]);
    expect(scan.refused.map((r) => [r.package, r.reason])).toEqual([["api7-host", "needs plugin API 7, this kestrel-cli has 6; update kestrel-cli"]]);
  });
});

describe("the engine reports an outdated host package and refuses to write", () => {
  async function outdatedProject(field: Record<string, unknown> | undefined): Promise<void> {
    const manifest = field === undefined ? { dependencies: { "@michaelthielemann/kestrel-upgrade": "^5.8.0" } } : { kestrel: field };
    await installHost(dir, "example-host", manifest, { "cli/plugin.mjs": pluginSource() });
    await writeProject(dir, { "example-host": "1.0.0", "@michaelthielemann/kestrel": "^5.8.0" });
    await writeFile(join(dir, "kestrel.config.ts"), 'throw new Error("only loads through its host");\n');
  }

  for (const [label, field] of [
    ["without a kestrel field", undefined],
    ["with an older engine range", { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN, engine: OLDER }],
    ["with a plugin API below the minimum", { plugin: "./cli/plugin.mjs", pluginApi: PLUGIN_API_MIN - 1, engine: MATCHING }],
  ] as const) {
    it(`check exits 1 and fix --write exits 2 with nothing written, ${label}`, async () => {
      await outdatedProject(field);
      const before = readFileSync(join(dir, "package.json"), "utf8");
      const lines: string[] = [];
      const code = await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined });
      const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
      expect(code).toBe(1);
      const outdated = report.findings.find((f) => f.rule === "deps/host-outdated");
      expect(outdated).toMatchObject({ id: "deps/host-outdated:example-host", severity: "error", fix: { kind: "manual" } });

      const errors: string[] = [];
      const writeCode = await runCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: (l) => errors.push(l) });
      expect(writeCode).toBe(2);
      expect(errors.join("\n")).toContain('"example-host" 1.0.0 is not built for this kestrel-cli');
      expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);

      const dataCode = await runCli(["data", "--root", dir, "--db", join(dir, "missing.db")], { stdout: () => undefined, stderr: () => undefined });
      expect(dataCode).toBe(2);
      expect(existsSync(join(dir, "node_modules", "example-host", SIDE_EFFECT))).toBe(false);
    });
  }
});

describe("a 6.x backend project that depends on kestrel-cli", () => {
  it("reports no outdated host and checks clean", async () => {
    await mkdir(join(dir, "node_modules", "@michaelthielemann"), { recursive: true });
    await symlink(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core"), join(dir, "node_modules", "@michaelthielemann", "kestrel"), "dir");
    await installHost(dir, "@michaelthielemann/kestrel-cli", { version: VERSION, dependencies: { "@michaelthielemann/kestrel-upgrade": "^6.0.0" } });
    await writeProject(dir, { "@michaelthielemann/kestrel": "^6.0.0", "@michaelthielemann/kestrel-cli": "^6.0.0" });
    await writeFile(join(dir, "kestrel.config.ts"), 'import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";\nexport default defineConfig({ modules: [], triggers: [] });\n');
    const lines: string[] = [];
    const code = await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, forceInstalledMajor: 6 });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    expect(report.findings.filter((f) => f.rule.startsWith("deps/"))).toEqual([]);
    expect(report.tiers.boot).toBe("done");
    expect(code).toBe(0);
  });
});

describe("the engine refuses to write while a host package's kestrel field is refused", () => {
  it("fix --write and data exit 2 with nothing written", async () => {
    await installHost(dir, "example-host", { kestrel: { plugin: "../../evil.mjs", pluginApi: PLUGIN_API_MIN, engine: MATCHING } });
    await writeProject(dir, { "example-host": "1.0.0", "@michaelthielemann/kestrel": "^5.8.0" });
    const before = readFileSync(join(dir, "package.json"), "utf8");
    const errors: string[] = [];
    expect(await runCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: (l) => errors.push(l) })).toBe(2);
    expect(errors.join("\n")).toContain('"example-host"');
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
    expect(await runCli(["data", "--root", dir, "--db", join(dir, "missing.db")], { stdout: () => undefined, stderr: () => undefined })).toBe(2);
  });
});
