import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { CLI_DIR, loadTrace, REPO, removeDir, runCli, tempDir } from "./harness.ts";

const OPS = "@michaelthielemann/kestrel-ops";
const TRANSFORM = ["--experimental-transform-types"];
const OPS_COMMANDS = ["status", "backup", "restore", "update"] as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function project(label: string, withOps: boolean): string {
  const dir = tempDir(label);
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "example-site", private: true }));
  if (withOps) {
    mkdirSync(join(dir, "node_modules", "@michaelthielemann"), { recursive: true });
    symlinkSync(join(REPO, "packages", "ops"), join(dir, "node_modules", "@michaelthielemann", "kestrel-ops"), "dir");
  }
  return dir;
}

function commandsOf(usage: string): string[] {
  const section = usage.split("\ncommands:\n")[1]?.split("\n\n")[0] ?? "";
  return section.split("\n").map((line) => /^ {2}(\S+)/.exec(line)?.[1] ?? "").filter((name) => name !== "");
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function readManifest(dir: string): Manifest {
  return boundaryCast<Manifest>(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), "json");
}

function installedDir(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`${name} is not installed for ${from}`);
  }
}

function productionTree(dir: string, seen = new Map<string, string>()): Map<string, string> {
  const manifest = readManifest(dir);
  const optional = new Set(Object.entries(manifest.peerDependenciesMeta ?? {}).filter(([, meta]) => meta.optional === true).map(([name]) => name));
  const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => !optional.has(name))];
  for (const name of names) {
    if (seen.has(name)) continue;
    const found = installedDir(name, dir);
    seen.set(name, found);
    productionTree(found, seen);
  }
  return seen;
}

describe("kestrel status, backup, restore and update", () => {
  it("--help lists the four operations commands next to the existing ones and no pipeline-only command", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(commandsOf(help.stdout)).toEqual(["start", "check", "explain", "manifest", "openapi", "upgrade", "status", "backup", "restore", "update", "help"]);
    expect(help.stdout).not.toMatch(/\bbundle\b|\bdeploy\b|--ci\b/);
  });

  it("help <command> shows the usage of each operations command", async () => {
    for (const command of OPS_COMMANDS) {
      const help = await runCli(["help", command]);
      expect(help.code, command).toBe(0);
      expect(help.stdout, command).toContain(`usage: kestrel ${command}`);
    }
  });

  it("without kestrel-ops in the project prints how to install it and exits 2, for every operations command", async () => {
    const dir = project("no-ops", false);
    for (const command of OPS_COMMANDS) {
      const result = await runCli([command, ...(command === "backup" ? ["list"] : [])], { cwd: dir, env: { NODE_PATH: "" } });
      expect(result.code, command).toBe(2);
      expect(result.stderr, command).toContain(`kestrel ${command} needs ${OPS}`);
      expect(result.stderr, command).toContain(`pnpm add -D ${OPS}`);
      expect(result.stdout, command).toBe("");
    }
  });

  it("loads neither kestrel-ops nor an S3 client for --help, upgrade or a missing kestrel-ops", async () => {
    const dir = project("load-trace", true);
    const trace = loadTrace(dir);
    expect((await runCli(["--help"], { cwd: dir, nodeArgs: trace.nodeArgs, env: trace.env })).code).toBe(0);
    await runCli(["upgrade", "check", "--root", dir], { cwd: dir, nodeArgs: trace.nodeArgs, env: trace.env });
    expect(trace.urls().filter((url) => url.includes("kestrel-ops") || url.includes("/packages/ops/") || url.includes("@aws-sdk"))).toEqual([]);
  });

  it("hands the arguments to kestrel-ops in the project, which answers a missing kestrel.environments.json with exit 2", async () => {
    const dir = project("with-ops", true);
    const result = await runCli(["backup", "list", "--json"], { cwd: dir, nodeArgs: TRANSFORM });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("kestrel.environments.json not found");
    expect(boundaryCast<Record<string, unknown>>(JSON.parse(result.stdout), "json")).toMatchObject({ schema: "kestrel-ops/error@1", ok: false });
    const usage = await runCli(["restore", "--frobnicate"], { cwd: dir, nodeArgs: TRANSFORM });
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("unknown option --frobnicate");
  });

  it("update --help and help update list only the seven commands an operator runs", async () => {
    const seven = ["prepare", "accept", "rollback", "status", "resume", "abort", "cleanup"];
    for (const args of [["update", "--help"], ["help", "update"]]) {
      const help = await runCli(args, { cwd: project("update-help", false), env: { NODE_PATH: "" } });
      expect(help.code, args.join(" ")).toBe(0);
      expect([...help.stdout.matchAll(/kestrel update (\S+)/g)].map((m) => m[1]), args.join(" ")).toEqual(seven);
      expect(help.stdout, args.join(" ")).not.toMatch(/\b(deploy|verify|bundle)\b/);
    }
  });

  it("update hands every command to the update assistant of kestrel-ops in the project", async () => {
    const dir = project("update", true);
    const prepare = await runCli(["update", "prepare", "--env", "prod"], { cwd: dir, nodeArgs: TRANSFORM });
    expect(prepare.code).toBe(2);
    expect(prepare.stderr).toContain("kestrel.environments.json not found");
    expect(prepare.stderr).not.toContain("no update assistant");
    const status = await runCli(["update", "status", "--json"], { cwd: dir, nodeArgs: TRANSFORM });
    expect(status.code).toBe(2);
    expect(boundaryCast<Record<string, unknown>>(JSON.parse(status.stdout), "json")).toMatchObject({ schema: "kestrel-ops/update-status@1", ok: false, exitCode: 2 });
    const usage = await runCli(["update", "frobnicate"], { cwd: dir, nodeArgs: TRANSFORM });
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("unknown update command frobnicate");
  });

  it("update bundle writes the facts the project's host plugin contributes into the bundle", async () => {
    const dir = project("update-bundle", true);
    const host = join(dir, "node_modules", "example-host");
    mkdirSync(host, { recursive: true });
    const version = boundaryCast<{ version: string }>(JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")), "json").version;
    writeFileSync(join(host, "package.json"), JSON.stringify({ name: "example-host", version: "1.0.0", type: "module", kestrel: { plugin: "./plugin.mjs", pluginApi: 6, engine: `^${version.split(".")[0] ?? "0"}.0.0` } }));
    writeFileSync(join(host, "plugin.mjs"), `export default () => ({ kind: "example", detect: async () => true, load: async () => ({ issues: [] }), ops: () => ({ readyPath: "/ready", secretEnvNames: ["SESSION_SECRET"], contentMigrations: ["pages-mark-migrated"], blobstoreFromEnv: () => undefined }) });\n`);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "example-site", private: true, dependencies: { "example-host": "1.0.0", [OPS]: "*" } }));
    writeFileSync(join(dir, "kestrel.environments.json"), JSON.stringify({ environments: { prod: { target: { adapter: "local", dir: ".", database: "data/kestrel.db", command: ["node", "server.mjs"], disk: "ephemeral" }, storage: { bucket: "b" }, app: { replicaPrefix: "database/", mediaPrefix: "media/", deliveryPrefix: "www/" }, backups: { prefix: "kestrel-backups/" } } } }));
    const result = await runCli(["update", "bundle"], { cwd: dir, nodeArgs: TRANSFORM });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const info = boundaryCast<{ hostFacts: Record<string, unknown> }>(JSON.parse(readFileSync(join(dir, ".kestrel-ops", "bundle.json"), "utf8")), "json");
    expect(info.hostFacts).toEqual({ readyPath: "/ready", secretEnvNames: ["SESSION_SECRET"], contentMigrations: ["pages-mark-migrated"] });
  }, 120_000);

  it("hands the host plugin's facts to every update command that continues a run, and loads no plugin for update status", async () => {
    const dir = project("update-resume-facts", true);
    const host = join(dir, "node_modules", "example-host");
    mkdirSync(host, { recursive: true });
    const version = boundaryCast<{ version: string }>(JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")), "json").version;
    writeFileSync(join(host, "package.json"), JSON.stringify({ name: "example-host", version: "1.0.0", type: "module", kestrel: { plugin: "./plugin.mjs", pluginApi: 6, engine: `^${version.split(".")[0] ?? "0"}.0.0` } }));
    writeFileSync(join(host, "plugin.mjs"), `import { appendFileSync } from "node:fs";\nexport default () => ({ kind: "example", detect: async () => true, load: async () => ({ issues: [] }), ops: (root) => { appendFileSync(root + "/ops-facts.log", "asked\\n"); return { contentMigrations: ["pages-mark-migrated"], blobstoreFromEnv: () => undefined }; } });\n`);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "example-site", private: true, dependencies: { "example-host": "1.0.0", [OPS]: "*" } }));
    writeFileSync(join(dir, "kestrel.environments.json"), JSON.stringify({ environments: { prod: { target: { adapter: "local", dir: ".", database: "data/kestrel.db", command: ["node", "server.mjs"], disk: "ephemeral" }, storage: { bucket: "b" }, app: { replicaPrefix: "database/", mediaPrefix: "media/", deliveryPrefix: "www/" }, backups: { prefix: "kestrel-backups/" } } } }));
    const asked = (): number => (existsSync(join(dir, "ops-facts.log")) ? readFileSync(join(dir, "ops-facts.log"), "utf8").split("\n").filter((line) => line !== "").length : 0);
    await runCli(["update", "status", "--env", "prod"], { cwd: dir, nodeArgs: TRANSFORM, env: { XDG_STATE_HOME: join(dir, "state") } });
    expect(asked()).toBe(0);
    for (const sub of ["resume", "verify", "rollback", "abort"]) {
      const before = asked();
      const result = await runCli(["update", sub, "--env", "prod"], { cwd: dir, nodeArgs: TRANSFORM, env: { XDG_STATE_HOME: join(dir, "state") } });
      expect(result.code, `${sub}: ${result.stderr}`).toBe(2);
      expect(asked(), sub).toBe(before + 1);
    }
  }, 120_000);

  it("keeps kestrel-ops and every @aws-sdk package out of the CLI's production dependency tree", () => {
    const manifest = readManifest(CLI_DIR);
    expect(manifest.dependencies?.[OPS]).toBeUndefined();
    expect(manifest.peerDependencies?.[OPS]).toBeUndefined();
    const tree = productionTree(CLI_DIR);
    expect(tree.size).toBeGreaterThan(3);
    expect([...tree.keys()].filter((name) => name === OPS || name.startsWith("@aws-sdk/") || name.startsWith("@smithy/"))).toEqual([]);
  });
});
