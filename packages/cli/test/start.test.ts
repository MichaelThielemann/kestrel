import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { CLI_DIR, copyProject, freePort, loadTrace, MINIMAL, removeDir, runCli, startAndStop } from "./harness.ts";

const FORBIDDEN = /kestrel-upgrade|kestrel-openapi|\/packages\/(upgrade|openapi)\/|@babel\/|jiti|\/cli\/src\/(inspectProject|inspect\/|commands\/(?!start))/;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

async function minimalCopy(): Promise<string> {
  const dir = copyProject(MINIMAL, "start");
  dirs.push(dir);
  const config = join(dir, "kestrel.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace("port: 4000", `port: ${await freePort()}`));
  return dir;
}

describe("kestrel start loads the project's core and nothing else", { timeout: 60_000 }, () => {
  for (const [label, args, entry] of [
    ["without a command", [], undefined],
    ["with start", ["start"], undefined],
    ["through the kestrel-cli entry", [], join(CLI_DIR, "src", "kestrel-cli.ts")],
  ] as const) {
    it(`starts, stops cleanly on SIGTERM and loads no upgrade, openapi or inspection code, ${label}`, async () => {
      const dir = await minimalCopy();
      const trace = loadTrace(dir);
      const result = await startAndStop(args, { cwd: dir, nodeArgs: trace.nodeArgs, env: trace.env, ...(entry === undefined ? {} : { entry }) });
      expect(result.started).toBe(true);
      expect(result.code).toBe(0);
      const urls = trace.urls();
      expect(urls.some((url) => url.includes("/packages/core/src/boot.ts"))).toBe(true);
      expect(urls.filter((url) => FORBIDDEN.test(url))).toEqual([]);
    });
  }

  it("fails a broken boot with exit 1, names the host package that starts the project, and never imports its plugin", async () => {
    const dir = await minimalCopy();
    const trace = loadTrace(dir);
    writeFileSync(join(dir, "kestrel.config.ts"), 'import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";\nexport default defineConfig({ modules: [{ use: "./modules/missing.ts", config: {} }], triggers: [] });\n');
    const hostDir = join(dir, "local_modules", "example-host");
    mkdirSync(join(hostDir, "cli"), { recursive: true });
    writeFileSync(join(hostDir, "package.json"), JSON.stringify({ name: "example-host", version: "1.0.0", type: "module", kestrel: { plugin: "./cli/plugin.mjs", pluginApi: 4, engine: "^5.0.0" } }));
    writeFileSync(join(hostDir, "cli", "plugin.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("../plugin-ran", import.meta.url), "yes");\nexport default () => ({});\n');
    const pkg = boundaryCast<{ dependencies: Record<string, string> }>(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), "json");
    pkg.dependencies["example-host"] = "file:./local_modules/example-host";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    removeDir(join(dir, "node_modules"));
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(realpathSync(join(MINIMAL, "node_modules", "@michaelthielemann")), join(dir, "node_modules", "@michaelthielemann"), "dir");
    symlinkSync(hostDir, join(dir, "node_modules", "example-host"), "dir");
    const result = await runCli([], { cwd: dir, nodeArgs: trace.nodeArgs, env: trace.env });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("boot failed");
    expect(result.stdout + result.stderr).toContain('this project is started by its host package \\"example-host\\"');
    expect(existsSync(join(hostDir, "plugin-ran"))).toBe(false);
    expect(trace.urls().filter((url) => FORBIDDEN.test(url) || url.includes("example-host"))).toEqual([]);
  });

  it("the same trace sees the inspection code when a command needs it", async () => {
    const dir = await minimalCopy();
    const trace = loadTrace(dir);
    const result = await runCli(["check"], { cwd: dir, nodeArgs: trace.nodeArgs, env: trace.env });
    expect(result.code).toBe(0);
    expect(trace.urls().some((url) => FORBIDDEN.test(url))).toBe(true);
  });

  it("refuses any argument after start with exit 2", async () => {
    const dir = await minimalCopy();
    const result = await runCli(["start", "--port", "1"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("start takes no options");
  });
});
