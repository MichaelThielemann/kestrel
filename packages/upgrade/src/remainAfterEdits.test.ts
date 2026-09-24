import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "..", "..");

async function runFixLines(root: string): Promise<string[]> {
  const lines: string[] = [];
  await runUpgradeCli(["fix", "--root", root], { stdout: (l) => lines.push(l), stderr: () => undefined, forceInstalledMajor: 6 });
  return lines;
}

async function remainLine(fixture: string): Promise<string | undefined> {
  const lines = await runFixLines(join(HERE, "..", "__fixtures__", fixture));
  return lines.find((l) => l.startsWith("after these edits:"));
}

async function linkPackage(nodeModulesDir: string, name: string, packageDirName: string): Promise<void> {
  const scope = join(nodeModulesDir, "@michaelthielemann");
  await mkdir(scope, { recursive: true });
  await symlink(resolve(PACKAGES_DIR, packageDirName), join(scope, name), "dir");
}

async function projectMissingEventsDirect(dir: string): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", type: "module", dependencies: { "@michaelthielemann/kestrel": "^5.8.0", "@michaelthielemann/kestrel-events-inmemory": "^5.8.0", "@michaelthielemann/kestrel-persistence-sqlite": "^5.8.0" } }, null, 2),
  );
  await writeFile(
    join(dir, "kestrel.config.ts"),
    `import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", busyTimeoutMs: 20000 } },
  ],
  triggers: [],
  pipelinesDir: "./pipelines",
});
`,
  );
  await mkdir(join(dir, "pipelines"), { recursive: true });
  await writeFile(
    join(dir, "pipelines", "publishNote.ts"),
    `import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "publishNote",
  steps: ["events.emit:note.published"],
});
`,
  );
  const nodeModules = join(dir, "node_modules");
  await linkPackage(nodeModules, "kestrel", "core");
  await linkPackage(nodeModules, "kestrel-contracts", "contracts");
  await linkPackage(nodeModules, "kestrel-events-inmemory", "events-inmemory");
  await linkPackage(nodeModules, "kestrel-persistence-sqlite", "persistence-sqlite");
  await symlink(resolve(HERE, "..", "..", "..", "node_modules", "zod"), join(nodeModules, "zod"), "dir");
}

async function runFixLinesWithoutWorkspaceFallback(root: string): Promise<string[]> {
  const scriptFile = join(root, "__run-fix.mjs");
  const resultFile = join(root, "__result.json");
  const pluginModule = join(PACKAGES_DIR, "upgrade", "src", "plugin.ts");
  await writeFile(
    scriptFile,
    `import { writeFile } from "node:fs/promises";
import { runUpgradeCli } from ${JSON.stringify(pluginModule)};
const lines = [];
await runUpgradeCli(["fix", "--root", ${JSON.stringify(root)}], { stdout: (l) => lines.push(l), stderr: (l) => lines.push("STDERR: " + l), forceInstalledMajor: 6 });
await writeFile(${JSON.stringify(resultFile)}, JSON.stringify(lines));
`,
  );
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptFile], { env: { ...process.env, NODE_PATH: "" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`child exited ${String(code)}: ${stderr}`))));
  });
  return boundaryCast<string[]>(JSON.parse(await readFile(resultFile, "utf8")), "json");
}

describe("fix preview counts what a boot of the fully edited copy would still reject", () => {
  it("drops an unknown-step boot error that the matching source auto-fix resolves", async () => {
    expect(await remainLine("event-emit-5.8")).toBe("after these edits: 0 errors remain (0 need your answer, 0 manual)");
  });

  it("keeps an unknown-step boot error no edit resolves, and names the pipeline the failure left unchecked", async () => {
    expect(await remainLine("minimal-5.8")).toBe("after these edits: 1 errors remain (0 need your answer, 1 manual) (1 not checked)");
  });
});

describe("fix preview when an edit adds a package the project does not have installed", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("never counts a boot it could not load, names the missing package, and lists the unverified boot findings", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-missing-pkg-"));
    await projectMissingEventsDirect(dir);
    const lines = await runFixLinesWithoutWorkspaceFallback(dir);
    expect(lines.some((l) => l.startsWith("after these edits:"))).toBe(false);
    expect(lines.some((l) => l.includes("@michaelthielemann/kestrel-events-direct") && l.includes("install") && l.includes("run `fix` again"))).toBe(true);
    expect(lines.some((l) => l.trim().startsWith("not verified:") && l.includes("boot/unknown-step"))).toBe(true);
  });
});
